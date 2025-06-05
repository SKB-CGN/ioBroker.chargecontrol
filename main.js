'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const { join } = require('node:path');
const I18n = require('@iobroker/adapter-core').I18n;
const { RPCServer, createRPCError } = require('ocpp-rpc');
const { BlueLinky } = require('bluelinky');
const DEFAULT_CONNECTOR_ID = 1;
const DEFAULT_ID_TAG = 'iobcc';

class chargecontrol extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'chargecontrol',
        });

        /* Configurable Variables */
        this.settings = {
            /* Configured wallbox */
            wallbox: {
                minAmp: 6,
                maxAmp: 32,
            },
            /* Configured timeouts in seconds */
            timeout: {
                start: 300,
                stop: 300,
                protection: 300,
                power: 60,
                car: 600,
            },
            /* Surplus */
            surplus: {
                option: false,
                positive: false,
                retryStart: 3,
                retryStop: 3,
            },
            /* Battery */
            battery: {
                option: false,
                positive: false,
            },
            /* Main */
            main: {
                resetFinished: false,
            },
        };

        /* Adapter times */
        this.adapterIntervals = {
            power: null,
            car: null,
        };

        /* Adapter Timer */
        this.adapterIntervalTimer = {
            car: null,
        };

        // OCPP
        this.ocppPort = 10116;

        /* Adapter timeouts */
        this.adapterTimeouts = {
            available: null,
            surplusStart: null,
            surplusStop: null,
            firstStart: null,
            suspended: null,
            chargeProfile: null,
            chargeProfileInit: null,
        };

        /* Adapter error counter */
        this.adapterErrors = {
            start: 3,
        };

        /* Adapter retries */
        this.adapterRetries = {
            start: 3,
            stop: 3,
        };

        // Save connected clients
        this.connectedClient = null;
        this.ocppServer = null;

        // Bluelinky
        this.blueLinkyClient = null;
        this.vehicle = {
            vin: '',
            connected: false,
            status: {},
            vehicle: null,
        };

        /* Details of the wallbox */
        this.ocppCharge = {
            client: null,
            status: 'Unavailable',
            power: 0,
            current: 0,
            meterStart: 0,
            meterEnd: 0,
            session: 0,
            carConnected: false,
            supportedMeters: [],
            transactionId: 0,
        };

        /* ChargeDetails */
        this.chargeDetails = {
            charging: false,
            surplus: 0,
            homeBattery: 0,
            homeBatterySoc: 0,
            homeBatteryLimit: 100,
            inProgress: false,
            finished: false,
            duration: 0,
            mode: 0,
            requestAmp: 0,
            start: Date.now(),
            wallboxStarted: false,
            startTransaction: false,
            time: {
                surplusStart: 0,
                surplusStop: 0,
            },
        };

        /* ChargeModes */
        this.chargeModes = {
            0: '(0) Deactivated',
            1: '(1) Manual',
            2: '(2) Only Surplus',
            3: '(3) Minimal + Surplus',
            4: '(4) Fast',
        };

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        this.log.info('Starting ChargeControl');

        // Config
        const stateChargeMode = await this.getStateAsync('control.mode');
        this.chargeDetails.mode = Number(stateChargeMode.val);

        // Gather the user set ampere
        const stateAmp = await this.getStateAsync('control.chargeCurrent');
        this.chargeDetails.requestAmp = this.limitAmpere(Number(stateAmp.val));

        // Take up the old transactionId
        const stateTransactionId = await this.getStateAsync('ocpp.transactionId');
        this.ocppCharge.transactionId = Number(stateTransactionId.val);

        // Take the meter start Values
        // meterStart
        const stateMeterStart = await this.getStateAsync('ocpp.meterStart');
        this.ocppCharge.meterStart = Number(stateMeterStart.val);

        const subscribeArray = new Array();

        /* Subscribe to own states */
        this.subscribeStates('control.*');

        // Language
        await I18n.init(join(__dirname, 'lib/src'), this);

        /* Gather config */
        // Main
        this.settings.main.resetFinished = this.config.resetFinished;

        // Wallbox
        this.settings.wallbox = {
            minAmp: Math.max(Number(this.config.wallbox_ampere_min || 0), 6),
            maxAmp: Math.max(Number(this.config.wallbox_ampere_max || 0), 6),
        };

        // Surplus
        this.settings.surplus = {
            option: this.config.surplus_option,
            positive: this.config.surplus_positive,
        };

        if (this.config.surplus_id != '') {
            subscribeArray.push(this.config.surplus_id);

            // Receive the state
            const stateSurplusLimit = await this.getForeignStateAsync(this.config.surplus_id);
            this.calculateSurplus(Number(stateSurplusLimit.val));
        }

        // Battery
        this.settings.battery = {
            option: this.config.battery_option,
            positive: this.config.battery_positive,
        };

        if (this.config.battery_soc != '') {
            const stateBatteryLimit = await this.getStateAsync('control.homeBatteryLimit');
            this.chargeDetails.homeBatteryLimit = Number(stateBatteryLimit.val);
            subscribeArray.push(this.config.battery_soc);

            // Receive the state
            const stateBatterySoc = await this.getForeignStateAsync(this.config.battery_soc);
            this.chargeDetails.homeBatterySoc = Number(stateBatterySoc.val);
        }

        if (this.config.battery_id != '') {
            subscribeArray.push(this.config.battery_id);

            // Receive the state
            const stateBatteryLimit = await this.getForeignStateAsync(this.config.battery_id);
            this.calculateBattery(Number(stateBatteryLimit.val));
        }

        // Timeouts
        this.settings.timeout = {
            start: Math.max(Number(this.config.timeout_start || 0), 10),
            stop: Math.max(Number(this.config.timeout_stop || 0), 30),
            protection: Math.max(Number(this.config.timeout_protection || 0), 300),
            power: Math.max(Number(this.config.timeout_power || 0), 60),
            car: Math.max(Number(this.config.timeout_car || 0), 60),
        };

        // Subscribe to the states
        this.subscribeForeignStatesAsync(subscribeArray);
        this.log.info('Requesting the following states: ' + subscribeArray.toString());

        this.ocppPort = this.config.ocpp_port || 10116;

        // OCPP states
        let currentStatus = null;
        let previousStatus = null;

        // Reset Status
        this.setStateChangedAsync('ocpp.client', { val: '', ack: true });
        this.setStateChangedAsync('ocpp.heartbeat', { val: '', ack: true });

        this.setStateChangedAsync('ocpp.current', { val: 0, ack: true });
        this.setStateChangedAsync('ocpp.power', { val: 0, ack: true });

        this.setStateChangedAsync('ocpp.connected', { val: false, ack: true });
        this.setStateChangedAsync('ocpp.carConnected', { val: false, ack: true });

        this.setStateChangedAsync('ocpp.status', { val: 'Unavailable', ack: true });
        this.setStateChangedAsync('ocpp.session', { val: 0, ack: true });

        // Server
        this.ocppServer = new RPCServer({
            protocols: ['ocpp1.6', 'ocpp2.0.1'], // server accepts ocpp protocol
            strictMode: true, // enable strict validation of requests & responses
        });

        /* OCPP Listener */
        this.ocppServer.auth((accept, reject, handshake) => {
            // accept the incoming client
            accept({
                // anything passed to accept() will be attached as a 'session' property of the client.
                sessionId: handshake.identity, // Use the identity of the Wallbox
            });
        });

        this.ocppServer.on('client', async client => {
            // Set states
            const wallbox = client.session.sessionId;
            this.ocppCharge.client = wallbox;
            this.log.info(`Connection to OCPP-Server from '${wallbox}'!`);
            this.setStateChangedAsync('ocpp.client', { val: wallbox, ack: true });
            this.setStateChangedAsync('ocpp.connected', { val: true, ack: true });

            // Setup of the Wallbox complete?
            // Setup variables
            const stateIdentity = await this.getStateAsync('ocpp.setup.identity');
            const valIdentity = stateIdentity.val;

            const stateSetup = await this.getStateAsync('ocpp.setup.completed');
            let setupComplete = stateSetup.val;

            // Probably a new Wallbox
            if (wallbox != valIdentity) {
                this.setStateAsync('ocpp.setup.identity', { val: wallbox, ack: true });
                setupComplete = false;
            }

            this.log.debug(`Identity: ${valIdentity}, SetupComplete: ${setupComplete}`);

            let isMeterValuesActive = false;

            // Save the client
            this.connectedClient = client;

            // Configure the Wallbox
            const configureWallbox = async () => {
                try {
                    // Request Meter-states
                    const meterResponse = await this.sendCommand('ChangeConfiguration', {
                        key: 'MeterValuesSampledData',
                        value: 'Power.Active.Import,Energy.Active.Import.Register,Current.Offered,SoC',
                    });

                    if (!meterResponse || meterResponse.status !== 'Accepted') {
                        this.log.warn('Necessary MeterValues could not be requested!');
                        return false;
                    }

                    this.log.info('Necessary MeterValues requested successfully!');

                    // Request Meter-Sample-Interval
                    const meterSampleInterval = await this.sendCommand('ChangeConfiguration', {
                        key: 'MeterValueSampleInterval',
                        value: '10',
                    });

                    if (!meterSampleInterval || meterSampleInterval.status !== 'Accepted') {
                        this.log.warn('Necessary MeterValues interval could not be set!');
                        return false;
                    }

                    this.log.info('Necessary MeterValues interval of 10 seconds set successfully!');

                    // Request Meter-Sample-Interval
                    const websocketPingInterval = await this.sendCommand('ChangeConfiguration', {
                        key: 'WebSocketPingInterval',
                        value: '30',
                    });

                    if (!websocketPingInterval || websocketPingInterval.status !== 'Accepted') {
                        this.log.warn('Necessary Websocket interval could not be set!');
                        return false;
                    }

                    this.log.info('Necessary Websocket interval of 30 seconds set successfully!');

                    // Clear the existing ChargingProfile
                    const clearResponse = await this.deleteChargingProfile();

                    if (!clearResponse) {
                        this.log.warn('Previous installed ChargingProfiles could not be removed!');
                        return false;
                    }

                    this.log.info('Previous installed ChargingProfiles removed!');

                    // Set the new ChargingProfile

                    const setResponse = await this.sendCommand(
                        'SetChargingProfile',
                        this.generateChargeProfile(10, true),
                    );

                    if (!setResponse || setResponse.status !== 'Accepted') {
                        this.log.warn('Necessary Default-ChargingProfile could not be installed!');
                        return false;
                    }

                    this.log.info('Necessary Default-ChargingProfile installed successfully!');

                    // Set the availability of the Wallbox
                    const setAvailability = await this.sendCommand('ChangeAvailability', {
                        type: 'Operative',
                        connectorId: DEFAULT_CONNECTOR_ID,
                    });

                    if (!setAvailability || setAvailability.status !== 'Accepted') {
                        this.log.warn('Necessary Availability could not be set!');
                        return false;
                    }

                    this.log.info('Necessary Availability set successfully!');

                    // Request the Meters to check
                    const meterRequest = await this.sendCommand('TriggerMessage', {
                        requestedMessage: 'MeterValues',
                        connectorId: DEFAULT_CONNECTOR_ID,
                    });

                    if (!meterRequest || meterRequest.status !== 'Accepted') {
                        this.log.warn('MeterValues could not be requested!');
                        return false;
                    }

                    this.log.info('Request of MeterValues successfully!');

                    return true;
                } catch (error) {
                    this.log.error('An error occurred while configuring the Wallbox: ' + error);
                    return false;
                }
            };

            const setupWallbox = async requestMeter => {
                if (!setupComplete) {
                    if (!isMeterValuesActive) {
                        this.log.info('Setting up the configuration on the wallbox!');
                        // Setup the wallbox
                        const setup = await configureWallbox();
                        if (setup) {
                            setupComplete = true;
                            this.log.info('Configuration of the Wallbox successfully!');
                            //this.setStateAsync('ocpp.setup.completed', { val: true, ack: true });
                        } else {
                            this.log.warn('Configuration of the Wallbox was not successfully!');
                        }
                    }
                } else {
                    this.log.info(`Wallbox "${valIdentity}" is known and already configured!`);
                    if (requestMeter) {
                        this.log.info('Requesting initial parameters from the wallbox!');
                        this.sendCommand('TriggerMessage', { requestedMessage: 'MeterValues' });
                    }
                }
            };

            // BootNotification requests
            client.handle('BootNotification', ({ params }) => {
                this.log.info(`[OCPP]: Server got BootNotification from ${client.identity}:`, params);

                // respond to accept the client
                return {
                    status: 'Accepted',
                    interval: 60,
                    currentTime: new Date().toISOString(),
                };
            });

            // Heartbeat requests
            client.handle('Heartbeat', async ({ params }) => {
                this.log.debug(
                    `[OCPP]: Server got Heartbeat from '${client.identity}' at ${new Date().toLocaleString()}`,
                    params,
                );
                this.setStateChangedAsync('ocpp.heartbeat', { val: new Date().toISOString(), ack: true });

                // respond with the server's current time.
                return {
                    currentTime: new Date().toISOString(),
                };
            });

            // StopTransaction requests
            client.handle('StopTransaction', async ({ params }) => {
                this.log.info(
                    `Server got StopTransaction from '${client.identity}' at ${new Date().toLocaleString()}`,
                    params,
                );

                // Save MeterVals
                this.ocppCharge.meterEnd = params.meterStop;
                this.setStateChangedAsync('ocpp.meterEnd', { val: params.meterStop, ack: true });

                // Handle Reasons
                switch (params.reason) {
                    case 'HardReset':
                    case 'EmergencyStop':
                    case 'Local':
                    case 'Other':
                    case 'PowerLoss':
                    case 'Reboot':
                        // ToDo
                        break;

                    case 'EVDisconnected':
                        break;
                }

                // respond with the idTagInfo
                return {
                    idTagInfo: {
                        status: 'Accepted',
                    },
                };
            });

            // StartTransaction requests
            client.handle('StartTransaction', async ({ params }) => {
                this.log.info(
                    `Server got StartTransaction from '${client.identity}' at ${new Date().toLocaleString()}`,
                    params,
                );

                // Generate a new TransactionId
                const newTransactionId = Math.floor(Math.random() * 1000000) + 1;
                this.setStateChangedAsync('ocpp.transactionId', { val: newTransactionId, ack: true });
                this.setStateChangedAsync('ocpp.meterStart', { val: params.meterStart, ack: true });

                // Save MeterVals
                this.ocppCharge = {
                    ...this.ocppCharge,
                    meterStart: params.meterStart,
                    meterEnd: 0,
                    transactionId: newTransactionId,
                };

                // Set the charge-profile
                this.adapterTimeouts.chargeProfileInit = setTimeout(() => {
                    // First start the RemoteTransAction with minimum 10 Ampere or higher
                    const setAmps = this.limitAmpere(Math.max(10, this.chargeDetails.requestAmp));

                    this.log.info(`Setting initial charge-profile with ${setAmps}A!`);

                    this.adapterTimeouts.chargeProfileInit = null;

                    // Set the profile
                    this.setWallbox(setAmps);
                }, 2000);

                // respond with the idTagInfo
                return {
                    idTagInfo: {
                        status: 'Accepted',
                    },
                    transactionId: newTransactionId,
                };
            });

            // StatusNotification requests
            client.handle('StatusNotification', async ({ params }) => {
                // Set the client status
                previousStatus = currentStatus;
                currentStatus = params;

                this.log.info('[OCPP]: Previous Wallbox Status:' + JSON.stringify(previousStatus));
                this.log.info('[OCPP]: Current Wallbox Status:' + JSON.stringify(currentStatus));

                this.setStateChangedAsync('ocpp.status', { val: currentStatus.status, ack: true });

                // Set OCPP Status
                this.ocppCharge.status = currentStatus.status;
                this.ocppCharge.carConnected =
                    currentStatus.status === 'Preparing' ||
                    currentStatus.status === 'Charging' ||
                    currentStatus.status === 'SuspendedEVSE' ||
                    currentStatus.status === 'SuspendedEV';
                this.chargeDetails.finished = false;
                this.chargeDetails.inProgress = false;
                this.chargeDetails.charging = false;

                // Handle the current StatusNotification
                switch (currentStatus.status) {
                    case 'Available':
                        // Clear the available timer
                        clearTimeout(this.adapterTimeouts.available);

                        // Timeout-Handler, as the Wallbox could send the "wrong status" during initial connection
                        this.adapterTimeouts.available = setTimeout(async () => {
                            // Check the status again after 2 seconds
                            if (currentStatus.status == 'Available') {
                                // Setup
                                setupWallbox(true);

                                // Reset OCPP-Charge object
                                this.ocppCharge = {
                                    ...this.ocppCharge,
                                    current: 0,
                                    power: 0,
                                    session: 0,
                                    supportedMeters: this.ocppCharge.supportedMeters,
                                };
                            } else {
                                if (!setupComplete) {
                                    this.log.warn(
                                        `Wallbox Setup cancelled! The Wallbox is currently in state "${currentStatus.status}", which does not allow any configuration. Please restart the wallbox and/or unplug any connected vehicle!`,
                                    );
                                }
                            }
                        }, 2 * 1000); // 2 seconds delay

                        // Activate Interval for requesting updates from the car every 10 minutes
                        this.log.info('Activating car-update interval every 10 minutes!');
                        this.adapterIntervalTimer.car = setInterval(() => {
                            this.getVehicleStatus();
                        }, 10 * 60 * 1000);

                        break;

                    case 'Preparing':
                        this.log.info('[OCPP]: Wallbox is preparing a new car!');

                        // Start-time
                        this.chargeDetails.start = Date.now();
                        this.chargeDetails.inProgress = true;

                        // Run the charge-handler, to initiate the process
                        this.chargeHandler();
                        break;

                    case 'Charging':
                        this.log.info('[OCPP]: Wallbox changed to charging mode!');
                        this.chargeDetails.inProgress = true;
                        this.chargeDetails.charging = true;
                        this.chargeDetails.wallboxStarted = true;

                        // Clear the timeout for suspendedEV
                        this.clearStoredTimeout('suspended');
                        break;

                    case 'SuspendedEVSE':
                        // Init charge states
                        this.log.info('[OCPP]: Wallbox EVSE changed to suspended mode!');
                        this.chargeDetails.inProgress = true;
                        this.chargeDetails.wallboxStarted = true;
                        break;

                    case 'SuspendedEV':
                        // Init charge states
                        this.log.info('[OCPP]: Wallbox EV changed to car-suspended mode!');
                        this.chargeDetails.inProgress = true;
                        this.chargeDetails.wallboxStarted = true;

                        // If more energy should be charged, than the car can charge - react to car-suspend
                        if (previousStatus.status == 'Charging') {
                            this.chargeDetails.finished = true;
                            this.chargeDetails.inProgress = false;
                            this.log.info('[OCPP]: Car-charge finished!');
                            this.setInfoStates();
                        }

                        // Wallbox was available, but switched to Suspended try to regulate
                        if (previousStatus.status == 'Preparing') {
                            this.log.warn(
                                '[OCPP]: Wallbox was available, but car suspended! Waiting 300 seconds to force-stop it, as the car might stay in suspended mode!',
                            );

                            // Wait to force-stop the Wallbox, if the car is still in suspended mode
                            this.adapterTimeouts.suspended = setTimeout(async () => {
                                // Check again, if we stay in suspended mode
                                if (currentStatus.status == 'SuspendedEV') {
                                    this.log.info('[OCPP]: Car still suspended! Trying to force stop the Wallbox!');
                                    // Try to stop the transaction
                                    const response = await this.sendCommand('RemoteStopTransaction', {
                                        transactionId: this.ocppCharge.transactionId,
                                    });
                                    if (response?.status == 'Accepted') {
                                        this.log.warn(
                                            '[OCPP]: Wallbox stopped! Please unplug cable and re-init the charge process!',
                                        );
                                    }
                                }
                                this.adapterTimeouts.suspended = null;
                            }, 5 * 60 * 1000);
                        }

                        break;

                    case 'Finishing':
                        this.log.info('[OCPP]: Finishing!');
                        this.chargeDetails.finished = true;
                        this.chargeDetails.wallboxStarted = false;
                        this.adapterErrors.start = 3;

                        this.clearStoredTimeout('chargeProfile');

                        this.clearStoredTimeout('firstStart');
                        this.clearStoredTimeout('surplusStart');
                        this.clearStoredTimeout('surplusStop');
                        this.clearStoredTimeout('suspended');

                        // End the session, if car is unplugged
                        if (previousStatus.status == 'Charging') {
                            this.setStateChangedAsync('ocpp.power', { val: 0, ack: true });
                        }

                        // Reset the mode to "Only Surplus", if requested
                        if (this.settings.main.resetFinished) {
                            this.chargeDetails.mode = 2;
                            this.setStateChangedAsync('control.mode', { val: 2, ack: true });
                        }

                        // Clear the charge profile
                        this.deleteChargingProfile();

                        this.setInfoStates();

                        // Activate Interval for requesting updates from the car every 10 minutes
                        this.log.info('Activating car-update interval every 10 minutes!');
                        this.adapterIntervalTimer.car = setInterval(() => {
                            this.getVehicleStatus();
                        }, 10 * 60 * 1000);

                    // Cases for the Wallbox not connected!
                    case 'Unavailable':
                    case 'Faulted':
                        break;
                }

                return {};
            });

            // MeterValues
            client.handle('MeterValues', async ({ params }) => {
                isMeterValuesActive = true;
                const desiredMeasurands = [
                    { source: 'Power.Active.Import', destination: 'power' },
                    { source: 'Current.Offered', destination: 'current' },
                    { source: 'Energy.Active.Import.Register', destination: 'session' },
                ];

                const convertToWh = (value, unit) => {
                    switch (unit.toLocaleLowerCase()) {
                        default:
                        case 'wh':
                            return parseFloat(value); // No convertion necessary
                        case 'kWh':
                            return parseFloat(value) * 1000; // Convert from kWh to Wh
                        case 'mWh':
                            return parseFloat(value) / 1000; // Convert from mWh to Wh
                    }
                };

                // Map Values
                const measurands = params?.meterValue[0]?.sampledValue;

                // Tmp MeterValues
                let supportedMeterValues = new Array();

                if (measurands) {
                    measurands.forEach(element => {
                        const match = desiredMeasurands.find(measurand => measurand.source === element.measurand);
                        if (match) {
                            // Put into Tmp MeterValues
                            supportedMeterValues.push(element.measurand);

                            const dest = match.destination;
                            let value = convertToWh(element.value, element.unit);

                            // Session Sum
                            if (dest == 'session') {
                                value = Math.round(value - this.ocppCharge.meterStart);
                            }

                            // Set the states & object
                            this.setStateChangedAsync(`ocpp.${dest}`, { val: value, ack: true });
                            this.ocppCharge[dest] = value;
                        }
                    });

                    // Store the supported MeterValues
                    if (this.ocppCharge.supportedMeters.length === 0) {
                        this.ocppCharge.supportedMeters = supportedMeterValues;

                        this.setStateAsync('ocpp.setup.MeterValues', {
                            val: JSON.stringify(supportedMeterValues),
                            ack: true,
                        });

                        this.log.info(supportedMeterValues + JSON.stringify(supportedMeterValues));
                    }
                }

                this.log.debug(`[OCPP]: Server got MeterValues from ${client.identity}: ` + JSON.stringify(params));

                if (!setupComplete && !this.chargeDetails.inProgress) {
                    // Timeout for MeterValues
                    clearTimeout(this.adapterTimeouts.meterValues);
                    this.adapterTimeouts.meterValues = setTimeout(() => {
                        isMeterValuesActive = false;

                        // Check the status again after 2 seconds
                        if (currentStatus.status == 'Available') {
                            // Setup
                            setupWallbox(false);
                        }
                    }, 2 * 1000); // 2 seconds delay
                }

                // Handle Charging
                if (this.chargeDetails.inProgress) {
                    this.chargeHandler();
                }

                return {};
            });

            // Close requests
            client.handle('close', ({ params }) => {
                currentStatus = null;
                this.log.info(`[OCPP]: Server got Close from ${client.identity}:`, params);
                return {};
            });

            // create a wildcard handler to handle any RPC method
            client.handle(({ method, params }) => {
                // This handler will be called if the incoming method cannot be handled elsewhere.
                this.log.info(`[OCPP]: Server got ${method} from ${client.identity}:`, params);

                // throw an RPC error to inform the server that we don't understand the request.
                throw createRPCError('[OCPP]: Not Implemented');
            });

            client.on('message', ({ message, outbound }) => {
                if (!message.includes('MeterValues')) {
                    this.log.info((outbound ? '>>> ' : '<<< ') + new Date().toLocaleString() + message);
                }
            });
            return {};
        });

        try {
            await this.ocppServer.listen(this.ocppPort);
            this.log.info(`OCPP-Server started on Port: ${this.ocppPort}! Waiting for a Wallbox to connect!`);
        } catch (err) {
            this.log.error(`Could not start OCPP-Server. The following error was provided: ${err}`);
        }

        this.setInfoStates();

        // Login to Hyundai API
        await this.loginToHyundai();

        this.log.info('ChargeControl Adapter started!');
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Stop the OCPP-Server
            this.ocppServer.close();
            // Here you must clear all timeouts or intervals that may still be active
            clearTimeout(this.adapterTimeouts.available);
            clearTimeout(this.adapterTimeouts.chargeProfile);
            clearTimeout(this.adapterTimeouts.chargeProfileInit);
            clearTimeout(this.adapterTimeouts.firstStart);
            clearTimeout(this.adapterTimeouts.surplusStart);
            clearTimeout(this.adapterTimeouts.surplusStop);
            clearTimeout(this.adapterTimeouts.suspended);

            this.log.info('Adapter ChargeControl cleaned up everything ...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (id && state) {
            // Surplus - can be in User-environment as well
            if (id == this.config.surplus_id) {
                this.calculateSurplus(Number(state.val));
            }

            // Battery
            if (id == this.config.battery_id) {
                this.calculateBattery(Number(state.val));
            }

            if (id == this.config.battery_soc) {
                this.chargeDetails.homeBatterySoc = Number(state.val);
            }

            if (!state.ack) {
                if (id.toLowerCase().startsWith(this.namespace)) {
                    // Own states
                    const tmpControl = id.split('.')[3];
                    switch (tmpControl) {
                        // ChargeMode
                        case 'mode':
                            const mode = Number(state.val);
                            this.chargeDetails.mode = mode;
                            this.log.info(`ChargeMode changed to: ${this.chargeModes[mode]}!`);
                            this.setStateChangedAsync('control.mode', { ack: true });

                            // Run the charge handler
                            this.chargeHandler();
                            break;

                        case 'chargeCurrent':
                            // Check, if we are using the correct values for Wallbox
                            const ampere = this.limitAmpere(Number(state.val));
                            this.chargeDetails.requestAmp = ampere;

                            if (
                                this.chargeDetails.mode == 1 &&
                                ampere != this.ocppCharge.current &&
                                this.chargeDetails.wallboxStarted
                            ) {
                                this.log.info(`Requesting to change charge-current to: ${ampere}A!`);
                                const request = await this.setWallbox(ampere, true);
                                if (request?.status === 'Accepted') {
                                    this.setStateChangedAsync('control.chargeCurrent', { val: ampere, ack: true });
                                }
                            }
                            break;

                        case 'homeBatteryLimit':
                            this.chargeDetails.homeBatteryLimit = Number(state.val);
                            this.log.info(
                                `Home battery limit changed to: ${state.val}%! Current SoC: ${this.chargeDetails.homeBatterySoc}%!`,
                            );
                            this.setStateChangedAsync('control.homeBatteryLimit', { ack: true });
                            break;

                        default:
                            this.log.error(`No supported event for ${tmpControl} found!`);
                            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                            break;
                    }
                }
            }
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.messagebox" property to be set to true in io-package.json
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        //this.log.debug(`[onMessage] received command: ${obj.command} with message: ${JSON.stringify(obj.message)}`);
        if (obj && obj.message) {
            if (typeof obj.message === 'object') {
                this.log.info(obj.command + ': ' + JSON.stringify(obj.message));
                switch (obj.command) {
                    case 'getTelegramUserConfig':
                        if (obj && obj.message) {
                            const inst = obj.message.instance ? obj.message.instance : this.config.telegramInstance;
                            this.getForeignState(`${inst}.communicate.users`, (err, state) => {
                                err && this.log.error(err);
                                if (state && state.val) {
                                    const userListStr = state?.val;
                                    const targets = [{ value: 'allTelegramUsers', label: 'All Receiver' }];
                                    try {
                                        if (userListStr) {
                                            const userList = JSON.parse(userListStr);
                                            for (const i in userList) {
                                                targets.push({
                                                    value: userList[i].firstName
                                                        ? userList[i].firstName
                                                        : userList[i].userName,
                                                    label: userList[i].firstName
                                                        ? userList[i].firstName
                                                        : userList[i].userName,
                                                });
                                            }
                                            this.sendTo(obj.from, obj.command, targets, obj.callback);
                                            this.log.debug(obj.command + ': ' + JSON.stringify(targets));
                                        } else {
                                            this.sendTo(
                                                obj.from,
                                                obj.command,
                                                [{ label: 'Not available', value: '' }],
                                                obj.callback,
                                            );
                                        }
                                    } catch (err) {
                                        err && this.log.error(err);
                                        this.log.error('Cannot parse stored user IDs from Telegram!');
                                    }
                                }
                            });
                        }
                        break;
                }
            } else {
                this.log.error(`[onMessage] Received incomplete message via 'sendTo'`);

                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'Incomplete message' }, obj.callback);
                }
            }
        }
    }

    calculateSurplus(value) {
        const tmpSurplus = this.settings.surplus.option ? value * 1000 : value;
        const surplusValue = this.settings.surplus.positive ? Math.max(0, tmpSurplus) : Math.max(0, -tmpSurplus);
        this.chargeDetails.surplus = surplusValue;

        //this.log.info(`[Surplus]: ${surplusValue}W`);
    }

    calculateBattery(value) {
        const tmpBattery = this.settings.battery.option ? value * 1000 : value;
        const batteryValue = this.settings.battery.positive ? tmpBattery : -tmpBattery;
        this.chargeDetails.homeBattery = batteryValue;

        //this.log.info(`[Battery]: ${batteryValue}W | SoC: ${this.chargeDetails.homeBatterySoc}% | Limit: ${this.chargeDetails.homeBatteryLimit}%`};
    }

    /**
     * Login to Hyundai API with the given credentials and get the vehicle status.
     *
     * @throws {Error} If the server is not available or login credentials are wrong.
     * @throws {Error} If something went wrong with login.
     *
     * @returns {Promise<void>}
     */
    async loginToHyundai() {
        try {
            this.log.info('Login to Hyundai API!');
            const loginOptions = {
                username: this.config.account_email,
                password: this.config.account_password,
                pin: this.config.account_pin,
                brand: 'hyundai',
                region: 'EU',
                language: 'de',
            };
            this.blueLinkyClient = new BlueLinky(loginOptions);

            this.blueLinkyClient.on('ready', async vehicles => {
                this.log.info(vehicles.length + ' Vehicles found');
                this.vehicle.vin = vehicles[0].vehicleConfig.vin;
                this.vehicle.vehicle = vehicles[0];
                this.vehicle.connected = true;

                this.getVehicleStatus(true);
            });

            this.blueLinkyClient.on('error', async err => {
                // something went wrong with login
                this.log.error(err);
                this.log.error('Server is not available or login credentials are wrong');
            });
        } catch (error) {
            this.log.error('Error in login/on function');
            if (typeof error === 'string') {
                this.log.error(error);
            } else if (error instanceof Error) {
                this.log.error(error.message);
            }
        }
    }

    async getVehicleStatus(force = false) {
        if (!this.vehicle.connected) {
            return;
        }

        const vehicle = this.vehicle.vehicle;
        const currentSoC = await this.getStateAsync('car.soc-12V');
        const currentSoCValue = currentSoC?.val;

        if (force && currentSoCValue < 70) {
            force = false;
        }

        try {
            if (force) {
                this.log.info(`Getting live-status of vehicle! Battery-Soc: ${currentSoCValue}%`);
            } else {
                this.log.info(
                    `Getting server based status of vehicle! Battery-Soc: ${currentSoCValue}%! ${
                        currentSoCValue < 70 ? '12V battery is low!' : ''
                    }`,
                );
            }

            const response = await vehicle.fullStatus({ refresh: force, parsed: true });
            this.log.info(JSON.stringify(response));
            this.vehicle.status = response.vehicleStatus;

            this.setVehicleStatus();
        } catch (error) {
            this.log.warn(`Error getting vehicle status! Error: ${error}`);
            return {};
        }
    }

    setVehicleStatus() {
        try {
            const status = this.vehicle.status;
            const evStatus = status.evStatus;
            this.setStateChangedAsync('car.soc', evStatus.batteryStatus, true);
            this.setStateChangedAsync('car.soc-12V', status.battery.batSoc, true);

            // Remaining
            let remaining;
            const time = evStatus.remainTime2?.atc.value;
            const unit = evStatus.remainTime2?.atc.unit;

            switch (unit) {
                // Seconds
                case 0:
                    remaining = time;
                    break;

                // Minutes
                case 1:
                    remaining = time * 60;
                    break;

                // Hours
                case 2:
                    remaining = time * 3600;
                    break;
            }

            this.setStateChangedAsync('car.remaining', this.secondsToHHMMSS(remaining), true);
        } catch (error) {
            this.log.error(error);
        }
    }

    async chargeHandler() {
        this.log.info('[OCPP]: ' + JSON.stringify(this.ocppCharge));
        this.log.info('[Charge]: ' + JSON.stringify(this.chargeDetails));
        // If Wallbox is not connected and/or the car as well, not finished - not necessary to run it
        if (!this.ocppCharge.carConnected || !this.ocppCharge.client) {
            return;
        }

        this.chargeDetails.duration = Math.floor((Date.now() - this.chargeDetails.start) / 1000);

        // Wallbox needs to be started
        if (!this.chargeDetails.wallboxStarted) {
            this.log.info('Setting Wallbox profile in 2 seconds!');
            this.startWallbox();

            // Charging profile is set in StartTransaction.req
        }

        // Clear the car update interval
        this.clearStoredInterval('car');

        // During charging, receive updates directely from the car || otherwise use server values
        const timeoutCar = this.intervalHandler('car', this.settings.timeout.car);
        if (timeoutCar.status) {
            this.getVehicleStatus(this.chargeDetails.charging);
        } else {
            this.log.info(`[Car]: Update! Waiting ${timeoutCar.wait} seconds before next update!`);
        }

        // React to the proper mode
        switch (this.chargeDetails.mode) {
            /*
			(0) Deactivated
			(1) Manual
			(2) Only Surplus
			(3) Minimal + Surplus
			(4) Fast
			*/

            // Deactivated
            case 0:
                // Stop charging, if it is charging AND the Timeout for init is not active
                if (this.chargeDetails.charging && !this.adapterTimeouts.firstStart) {
                    // Notification Message
                    //this.notificationMessage = this.chargeMessage('aborted');

                    this.stopWallbox('Mode changed to deactivated!');
                }
                break;

            // Manual
            case 1:
                // Level the Wallbox to the request amperage
                if (this.chargeDetails.wallboxStarted) {
                    if (this.chargeDetails.requestAmp != this.ocppCharge.current) {
                        const timeout = this.intervalHandler('power', this.settings.timeout.power);
                        if (timeout.status) {
                            this.setWallbox(this.chargeDetails.requestAmp);
                        } else {
                            this.log.info(`[Power]: Waiting ${timeout.wait} seconds before sending new value!`);
                        }
                    }
                }

                break;

            // Only Surplus
            case 2: {
                // Check, what amperes we can use
                const homeBattery = this.config.battery_soc
                    ? this.chargeDetails.homeBatterySoc > this.chargeDetails.homeBatteryLimit
                    : true;

                const currentAmp = this.ocppCharge.current < this.settings.wallbox.minAmp ? 0 : this.ocppCharge.current;
                const surplusAmp = this.getAmpereFromWatt(this.chargeDetails.surplus);
                const batteryAmp = homeBattery ? this.getAmpereFromWatt(this.chargeDetails.homeBattery) : 0;
                const possibleAmp = Math.min(this.settings.wallbox.maxAmp, currentAmp + surplusAmp + batteryAmp);

                this.log.info(
                    `[Calculation]: Amps: ${possibleAmp}A (Current Amps: ${currentAmp}A, Surplus Amp: ${surplusAmp}A, Battery Amp: ${batteryAmp}A), Current Surplus: ${this.chargeDetails.surplus}W, HomeBattery: ${homeBattery} (SoC: ${this.chargeDetails.homeBatterySoc}%, Limit: ${this.chargeDetails.homeBatteryLimit}%)`,
                );

                // Protection Handler need to return true, before we can charge anything
                const timeout = this.intervalHandler('power', this.settings.timeout.power);
                if (!timeout.status) {
                    this.log.info(`[Protection]: Power! Waiting ${timeout.wait} seconds!`);
                    this.setInfoStates();
                    return;
                }

                const surplusStop = reason => {
                    if (!this.adapterTimeouts.surplusStop) {
                        if (this.chargeDetails.charging) {
                            this.log.info(
                                `[Regulation]: Regulating not possible! Waiting for enough energy! Will stop in ${this.settings.timeout.stop} seconds!`,
                            );

                            this.chargeDetails.time.surplusStop = Date.now();
                            this.adapterTimeouts.surplusStop = setTimeout(() => {
                                this.stopWallbox(reason);
                                this.adapterTimeouts.surplusStop = null;
                            }, this.settings.timeout.stop * 1000);
                        }
                    }

                    // Clear the timeout for start
                    this.clearStoredTimeout('surplusStart');
                };

                // Currently charging
                if (this.chargeDetails.charging) {
                    if (possibleAmp >= this.settings.wallbox.minAmp) {
                        if (possibleAmp !== currentAmp) {
                            this.log.info(
                                `[Regulation]: Regulating the Wallbox from ${currentAmp}A to ${possibleAmp}A!`,
                            );
                            this.setWallbox(possibleAmp);
                        }

                        // Zeitgeber zurücksetzen
                        this.clearStoredTimeout('surplusStop');
                        this.clearStoredTimeout('surplusStart');
                    } else {
                        this.log.info(
                            `[Regulation]: Not enough surplus/battery power to maintain charging (possible: ${possibleAmp}A < min: ${this.settings.wallbox.minAmp}A)`,
                        );
                        surplusStop('Too little surplus to continue charging.');
                    }
                } else {
                    // Currently not charging
                    if (this.chargeDetails.surplus > 0 && homeBattery) {
                        if (possibleAmp >= this.settings.wallbox.minAmp) {
                            this.log.info(
                                `[Regulation]: If surplus stays equal or above ${this.chargeDetails.surplus}W, the Wallbox will be started in ${this.settings.timeout.start} seconds!`,
                            );

                            if (!this.adapterTimeouts.surplusStart) {
                                this.chargeDetails.time.surplusStart = Date.now();

                                this.adapterTimeouts.surplusStart = setTimeout(() => {
                                    if (this.adapterTimeouts.firstStart) {
                                        this.log.info(
                                            '[Regulation]: Clearing the timeout for pausing the wallbox on init!',
                                        );
                                        this.clearStoredTimeout('firstStart');
                                    }

                                    if (this.chargeDetails.charging) {
                                        this.log.info('[Regulation]: Already charging!');
                                    } else {
                                        this.log.info(
                                            `[Regulation]: Starting the Wallbox as enough surplus since ${this.settings.timeout.start} seconds!`,
                                        );
                                        this.setWallbox(possibleAmp);
                                    }

                                    this.adapterTimeouts.surplusStart = null;
                                }, this.settings.timeout.start * 1000);
                            }

                            // Start possible -> cancel stop timer
                            this.clearStoredTimeout('surplusStop');
                        } else {
                            surplusStop('Regulation not possible! Surplus too low!');
                        }
                    } else {
                        this.log.info(
                            `[Regulation]: Regulating not possible! Waiting for enough energy! Timer running: ${
                                this.adapterTimeouts.surplusStop !== null
                            }`,
                        );
                        surplusStop(
                            `Surplus too low${
                                !homeBattery
                                    ? ` and Battery SoC ${this.chargeDetails.homeBatterySoc}% is below ${this.chargeDetails.homeBatteryLimit}%!`
                                    : '!'
                            }`,
                        );
                    }
                }

                break;
            }

            // Minimal + Surplus
            case 3:
                this.log.info(`[OCPP]: Wallbox is in charge mode!`);
                break;

            // Fast
            case 4:
                this.log.info(`[OCPP]: Wallbox is in charge mode!`);
                break;
        }

        // Set the info states
        this.setInfoStates();
    }

    /**
     * Set the info states.
     * These states are:
     * - `info.chargedPower`: The total energy charged in Wh.
     * - `info.charging`: True if the car is currently charging, false otherwise.
     * - `info.duration`: The duration of the charging session in HH:MM:SS.
     * - `info.finished`: True if the charging session is finished, false otherwise.
     */
    setInfoStates() {
        const cDetails = this.chargeDetails;
        const sTimeout = this.settings.timeout;
        this.setStateChangedAsync('info.charging', {
            val: cDetails.charging,
            ack: true,
        });

        this.setStateChangedAsync('ocpp.carConnected', { val: this.ocppCharge.carConnected, ack: true });

        this.setStateChangedAsync('info.duration', {
            val: this.secondsToHHMMSS(cDetails.duration),
            ack: true,
        });

        this.setStateChangedAsync('info.finished', {
            val: cDetails.finished,
            ack: true,
        });

        const surplusStart =
            cDetails.time.surplusStart > 0
                ? Math.max(0, Math.floor(sTimeout.start - (Date.now() - cDetails.time.surplusStart) / 1000))
                : 0;
        const surplusStartVal = this.secondsToHHMMSS(surplusStart);
        this.setStateChangedAsync('info.surplusStart', {
            val: surplusStartVal,
            ack: true,
        });

        const surplusStop =
            cDetails.time.surplusStop > 0
                ? Math.max(0, Math.floor(sTimeout.stop - (Date.now() - cDetails.time.surplusStop) / 1000))
                : 0;
        const surplusStopVal = this.secondsToHHMMSS(surplusStop);
        this.setStateChangedAsync('info.surplusStop', {
            val: surplusStopVal,
            ack: true,
        });
    }

    /**
     * Handles timing intervals for various operations by checking if a specified timeout has elapsed.
     * If the timeout has elapsed, it updates the interval's timestamp and returns a status indicating readiness.
     * Otherwise, it returns a status indicating the remaining wait time.
     *
     * @param {string} key - The identifier for the interval to manage.
     * @param {number} timeoutInSec - The timeout duration in seconds.
     * @returns {Object} An object containing a status boolean and, if not ready, the remaining wait time in seconds.
     */

    intervalHandler(key, timeoutInSec) {
        const now = Date.now();
        const timeoutInMs = timeoutInSec * 1000;

        if (!this.adapterIntervals[key]) {
            this.adapterIntervals[key] = now;
            return {
                status: true,
            };
        }

        const elapsed = now - this.adapterIntervals[key];
        if (elapsed >= timeoutInMs) {
            this.adapterIntervals[key] = now;

            return { status: true };
        }

        return { status: false, wait: Math.floor((timeoutInMs - elapsed) / 1000) };
    }

    /**
     * Clears a stored timeout by the given key.
     *
     * @param {string} key - The key of the timeout to clear.
     */
    clearStoredTimeout(key) {
        if (this.adapterTimeouts[key]) {
            clearTimeout(this.adapterTimeouts[key]);
            this.adapterTimeouts[key] = null;
            this.log.info(`[Timeout]: Cleared timeout for ${key}`);

            // Check, if we have a timer for it
            if (this.chargeDetails.time[key] > 0) {
                this.chargeDetails.time[key] = 0;
            }
        }
    }

    /**
     * Clears a stored interval by the given key.
     *
     * @param {string} key - The key of the interval to clear.
     */
    clearStoredInterval(key) {
        if (this.adapterIntervalTimer[key]) {
            clearInterval(this.adapterIntervalTimer[key]);
            this.adapterIntervalTimer[key] = null;
            this.log.info(`[Interval]: Cleared interval for ${key}`);
        }
    }

    /**
     * Sets the charging profile for the wallbox.
     *
     * @param {number} amps The new ampere value for the wallbox.
     * @param {boolean} user Whether the command was triggered by a user or not. If true, the command will be rejected if the timeout for sending the next command has not expired.
     * @param {number} retriesLeft The number of retries left. If the command fails, it will be retried up to this number of times. Defaults to 3.
     * @returns {Promise<Object>} The response object from the wallbox.
     */
    async setWallbox(amps, user = false, retriesLeft = 3) {
        const timeout = this.intervalHandler('power', this.settings.timeout.power);
        if (user && !timeout.status) {
            return {
                status: 'Rejected',
                message: `Cannot set new value for Ampere! New value will be sent in ${timeout.wait} seconds!`,
            };
        }

        const response = await this.sendCommand('SetChargingProfile', this.generateChargeProfile(amps));
        if (response?.status === 'Accepted') {
            this.clearStoredTimeout('chargeProfile');

            // Protect power with new timeout
            this.adapterIntervals.power = Date.now();
            this.log.info(`[OCPP]: Charging profile successfully set to ${amps}A!`);
        } else if (retriesLeft > 1) {
            this.log.warn(`[OCPP]: Failed to set profile. Retrying in 3s... (${retriesLeft - 1} retries left)`);
            this.adapterTimeouts.chargeProfile = setTimeout(() => {
                this.setWallbox(amps, user, retriesLeft - 1);
            }, 3 * 1000);
        } else {
            this.log.error(`[OCPP]: All attempts to set charging profile failed!`);
        }
        return response;
    }

    /**
     * @description Starts the Wallbox by sending a RemoteStartTransaction command.
     * First a minimum of 10 Ampere will be set and after 120 seconds the wallbox will be set to the correct values or into pause-mode if mode is Deactivated (0) or Surplus (2).
     * @returns {Promise<Object>} The response object from the wallbox
     */
    async startWallbox() {
        if (this.adapterErrors.start <= 0 || this.chargeDetails.wallboxStarted) {
            return;
        }

        // Delete charge profile
        await this.deleteChargingProfile();

        this.log.info(`[OCPP]: Sending start to Wallbox!`);
        const setAmps = this.limitAmpere(Math.max(10, this.chargeDetails.requestAmp));

        const response = await this.sendCommand('RemoteStartTransaction', {
            connectorId: DEFAULT_CONNECTOR_ID,
            idTag: DEFAULT_ID_TAG,
            //chargingProfile: this.generateChargeProfile(setAmps).csChargingProfiles,
        });

        if (response?.status === 'Accepted') {
            this.log.info(`[OCPP]: Wallbox has accepted the remote start!`);
            this.chargeDetails.wallboxStarted = true;
            this.adapterErrors.start = 3;

            // Protect power with new timeout
            this.adapterIntervals.power = Date.now();

            // Clear the timeout for car suspended
            if (this.adapterTimeouts.suspended) {
                this.log.info(`[OCPP]: Clearing timeout for car suspended!`);
                this.clearStoredTimeout('suspended');
            }

            // After 120 seconds set the Wallbox to the correct values or into pause-mode | Only in mode Deactivated (0) or Surplus (2)
            if (!this.adapterTimeouts.firstStart && (this.chargeDetails.mode == 0 || this.chargeDetails.mode == 2)) {
                const pauseAmpere = Math.max(2, this.settings.wallbox.minAmp - 1);
                this.adapterTimeouts.firstStart = setTimeout(() => {
                    this.log.info(
                        `[OCPP]: First Start: Setting Wallbox to pause-mode after 120s of start, because it is in mode ${
                            this.chargeModes[this.chargeDetails.mode]
                        }!`,
                    );
                    this.setWallbox(pauseAmpere);
                    this.adapterTimeouts.firstStart = null;
                }, 120 * 1000);
            }
        } else {
            this.adapterErrors.start -= 1;
            this.log.warn(`[OCPP]: RemoteStart-Action failed! Retries left: ${this.adapterErrors.start}`);
        }

        return response;
    }

    async deleteChargingProfile() {
        this.log.info('[OCPP]: Clear old charging profiles!');
        const response = await this.sendCommand('ClearChargingProfile', {});
        if (response?.status === 'Accepted' || response?.status === 'Unknown') {
            this.log.info(`[OCPP]: Charging profile successfully deleted!`);
            return true;
        }

        return false;
    }

    /**
     * Sends a command to stop the wallbox, setting the charging current to zero.
     * This sets the wallbox into a stopped state by updating the charging profile.
     */

    stopWallbox(reason) {
        this.log.info(`[OCPP]: Sending stop to Wallbox! Reason: ${reason}`);
        this.setWallbox(2);
    }

    /**
     * Generates a charging profile for the wallbox.
     *
     * @param {number} amps - The charging current in amperes.
     * @param {boolean} [defaultProfile=false] - If true, generates a default charging profile; otherwise, a transaction profile.
     * @returns {Object} The charging profile object containing the connectorId, csChargingProfiles with details such as chargingProfileId, stackLevel, chargingProfilePurpose, chargingProfileKind, and chargingSchedule.
     */

    generateChargeProfile(amps, defaultProfile = false) {
        return {
            connectorId: DEFAULT_CONNECTOR_ID,
            csChargingProfiles: {
                chargingProfileId: defaultProfile ? 1 : 2,
                stackLevel: defaultProfile ? 1 : 2,
                chargingProfilePurpose: defaultProfile ? 'TxDefaultProfile' : 'TxProfile',
                chargingProfileKind: 'Absolute',
                chargingSchedule: {
                    chargingRateUnit: 'A',
                    chargingSchedulePeriod: [
                        {
                            startPeriod: 0,
                            limit: amps,
                        },
                    ],
                },
            },
        };
    }

    async sendCommand(command, payload) {
        if (!this.connectedClient) {
            this.log.warn('No connected client found!');
            return {
                status: 'No client found!',
            };
        }

        try {
            const response = await this.connectedClient.call(command, payload);
            this.log.info('Answer of the client: ' + JSON.stringify(response));
            return response;
        } catch (error) {
            this.log.warn(`[OCPP]: Command "${command}" failed! ${error}`);
            return {
                status: error,
            };
        }
    }

    /**
     * Convert watt to ampere
     * @param {number} watt - Power in Watt
     * @returns {number} Ampere
     */
    getAmpereFromWatt(watt) {
        return Math.floor(watt / 230);
    }
    /**
     * Convert ampere to watt
     * @param {number} ampere - Current in Ampere
     * @returns {number} Watt
     */
    getWattFromAmpere(ampere) {
        return ampere * 230;
    }

    /**
     * Limits the given ampere value to be within the configured minimum and maximum values for the wallbox.
     * @param {number} ampere - The current in Ampere to be limited.
     * @returns {number} - The limited current value within the allowed range.
     */

    limitAmpere(ampere) {
        return Math.min(Math.max(ampere, this.settings.wallbox.minAmp), this.settings.wallbox.maxAmp);
    }

    /**
     * Converts a given number of seconds into a string in the format HH:MM:SS
     * @param {number} seconds - The number of seconds to convert
     * @returns {string} - The converted time as a string in the format HH:MM:SS
     */
    secondsToHHMMSS(seconds) {
        if (seconds == null) return; // check for null or undefined
        const date = new Date(0);
        date.setSeconds(seconds);
        return date.toISOString().slice(11, 19);
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = options => new chargecontrol(options);
} else {
    // otherwise start the instance directly
    new chargecontrol();
}
