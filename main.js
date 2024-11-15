'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

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
		this.surplus_option = false;
		this.surplus_positive = false;
		this.wallbox_start = '';
		this.wallbox_stop = '';
		this.wallbox_ampere_max = 32;
		this.wallbox_ampere_min = 6;
		this.car_update = '';
		this.timeout_start = 600;
		this.timeout_stop = 600;
		this.timeout_protection = 300;
		this.timeout_car = 300;
		this.timeout_power = 60;
		this.chargeMode = 0;

		/* Internal Variables */
		this.availableCars = new Array();
		this.currentCarConfig = new Array();
		this.carSocArray = new Array();
		this.carConnectArray = new Array();

		this.currentCar = {
			connected: false,
			soc: 0
		};
		this.wallboxConnected = false;
		this.currentSurplus = 0;
		this.surplusStart = null;
		this.surplusEnd = null;
		this.chargeInProgress = false;
		this.chargeCompleted = false;
		this.lastAction = null;
		this.chargeLimit = 0;
		this.carSoc = null;
		this.power = 0;
		this.adapterIntervals = {
			start: null,
			stop: null,
			car: null,
			power: null
		}

		this.chargeModes = {
			"0": "(0) Deactivated",
			"1": "(1) Only Surplus",
			"2": "(2) Minimal + Surplus",
			"3": "(3) Fast"
		}

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		let configOK = false;

		// Initialize your adapter here
		this.log.info("Starting ChargeControl");

		// Surplus state
		if (this.config.wallbox_connected != '') {
			// Config
			const tmpChargeMode = await this.getStateAsync('control.mode');
			const tmpChargeLimit = await this.getStateAsync('control.chargeLimit');
			const tmpPower = await this.getStateAsync('control.chargePower');

			const tmpWallboxConnected = await this.getForeignStateAsync(this.config.wallbox_connected);

			if (this.config.car_soc != '') {
				const tmpSoc = await this.getForeignStateAsync(this.config.car_soc);
				this.carSoc = tmpSoc.val;
			}

			this.surplus_option = this.config.surplus_option;
			this.surplus_positive = this.config.surplus_positive;
			this.wallbox_start = this.config.wallbox_start;
			this.wallbox_stop = this.config.wallbox_stop;
			this.wallbox_ampere_max = this.config.wallbox_ampere_max;
			this.wallbox_ampere_min = this.config.wallbox_ampere_min;
			this.car_update = this.config.car_update;
			this.timeout_start = this.config.timeout_start;
			this.timeout_stop = this.config.timeout_stop;
			this.timeout_protection = this.config.timeout_protection > 300 ? this.config.timeout_protection : 300;
			this.timeout_car = this.config.timeout_car > 120 ? this.config.timeout_car : 120;
			this.timeout_power = this.config.timeout_power > 60 ? this.config.timeout_power : 60;
			this.timeout_protection = 30;
			this.chargeMode = Number(tmpChargeMode.val);
			this.chargeLimit = tmpChargeLimit.val;
			this.wallboxConnected = tmpWallboxConnected.val;
			this.power = tmpPower.val;
			this.availableCars = this.config.carList;

			configOK = true;
		} else {
			this.log.error("You need to enter a state for 'wallbox connected' for the adapter to work!");
			configOK = false;
		}

		if (configOK) {
			const subscribeArray = [this.config.wallbox_connected];
			/* Subscribe to own states */
			this.subscribeStates("control.*");

			// Subscribe to all Wallbox states and Car SoC's
			for (let i = 0; i < this.availableCars.length; i++) {
				// SoC
				if (this.availableCars[i].soc != '') {
					subscribeArray.push(this.availableCars[i].soc);

					// Put into carSocArray
					this.carSocArray.push(this.availableCars[i].soc);
				}

				// Connected
				if (this.availableCars[i].connected != '') {
					subscribeArray.push(this.availableCars[i].connected);

					// Put into carConnectArray
					this.carConnectArray.push(this.availableCars[i].connected);

					// Detect an already connected car
					if (this.currentCarConfig.length == 0 && this.availableCars[i].connected != '') {
						const tmpCarCon = await this.getForeignStateAsync(this.availableCars[i].connected);
						const tmpCarSoc = await this.getForeignStateAsync(this.availableCars[i].soc);

						if (tmpCarCon.val != 0 && tmpCarSoc) {
							this.currentCarConfig = this.availableCars[i];
							this.currentCar = {
								connected: tmpCarCon.val != 0 ? true : false,
								soc: tmpCarSoc.val
							}
						}
					}
				}
			}

			this.log.info(`Current connected car: ${this.currentCarConfig.name || 'No car connected!'}`);
			if (this.currentCarConfig.name) {
				this.setInfoStates({ vehicleName: this.currentCarConfig.name });
			}

			if (this.config.surplus_id != '') {
				subscribeArray.push(this.config.surplus_id);
			}

			this.log.info(JSON.stringify(this.config.carList));

			this.subscribeForeignStatesAsync(subscribeArray);
			this.log.info("Requesting the following states: " + subscribeArray.toString());

			this.log.info('ChargeControl Adapter started!');

			// Handle Charging
			this.manageCharging();
		} else {
			this.log.error("Adapter shutting down, as no state is entered for 'wallbox connected'!");
			await this.stop?.({ exitCode: 11, reason: 'Config is invalid!' });
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

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
			if (state.ack) {
				// Wallbox connected
				if (id == this.config.wallbox_connected) {
					// Set Wallbox connected
					this.wallboxConnected = state.val;
					this.log.info(`Wallbox connetion changed: ${state.val ? 'connected' : 'disconnected'}`);

					// If no car is connected - new car has been connected
					if (state.val === true && this.currentCar.connected === false) {
						// Request to update all cars
						this.updateAllCars();
					}

					// If Wallbox is disconnected - current car has been disconnected
					if (state.val === false) {
						this.currentCarConfig = [];
						this.currentCar = {
							connected: false,
							soc: 0
						}
					}
				}

				// Surplus
				if (id == this.config.surplus_id) {
					// Format it
					let tmpPower = this.surplus_option ? Number(state.val * 1000) : Number(state.val);

					// Set surplus
					this.currentSurplus = this.surplus_positive ? Math.max(0, tmpPower) : Math.abs(tmpPower);
				}

				// Update current car only, if Wallbox is connected to a car
				if (this.wallboxConnected) {
					// Car connection
					if (this.carConnectArray.includes(id)) {
						this.currentCar.connected = state.val != 0 ? true : false;

						if (this.currentCar.connected) {
							this.log.info(`Car connected! ID: ${id}`);
							// Find the car, which is connected
							if (this.currentCarConfig.length === 0) {
								this.log.info("New car connected to Wallbox! Getting Data!");
								const tmpCar = this.availableCars.find(car => car.connected == id);
								if (tmpCar) {
									this.currentCarConfig = tmpCar;
									this.log.info('Car-Data : ' + JSON.stringify(tmpCar));
									// Get the SoC
									const tmpSoc = await this.getForeignState(this.currentCarConfig.soc);
									this.currentCar = {
										connected: true,
										soc: tmpSoc.val || 0
									}
									this.log.info(`Car '${this.currentCarConfig.name}' is now connected to the Wallbox!`);
									this.setInfoStates({
										vehicleName: this.currentCarConfig.name
									});
								}
							}
						} else {
							this.log.info(`Car '${this.currentCarConfig.name}' disconnected from Wallbox!`);
							this.setInfoStates({
								vehicleName: ''
							});

							this.currentCarConfig = [];
							this.currentCar = {
								connected: false,
								soc: 0
							}
						}
					}

					// Car SoC
					if (this.carSocArray.includes(id)) {
						this.log.info(`CurrentCar Soc updated: ${state.val}`)
						this.currentCar.soc = Number(state.val);
					}
				}
			}

			if (!state.ack) {
				if (id.toLowerCase().startsWith(this.namespace)) {
					// Own states
					const tmpControl = id.split(".")[3];
					switch (tmpControl) {
						// ChargeMode
						case 'mode':
							this.chargeMode = Number(state.val);
							this.log.info(`ChargeMode changed to: ${this.chargeModes[state.val]}!`);
							break;
						case 'chargePower':
							this.power = Number(state.val);
							this.log.info(`Charge - Power changed to: ${state.val}A!`);
							this.chargeCompleted = false;
							if (this.chargeInProgress) {
								await this.setWallbox();
							}
							break;
						case 'chargeLimit':
							this.chargeLimit = Number(state.val);
							this.log.info(`Charge - Limit changed to: ${state.val} % !`);
							break;
						default:
							this.log.error(`No supported event for ${tmpControl} found!`);
							this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
							break;
					}
				}
			}

			// Handle Charging
			this.manageCharging();
		}
	}

	async manageCharging() {
		this.log.info(`Charge - Log: Charge - Mode: ${this.chargeModes[this.chargeMode]}, Charge in progress: ${this.chargeInProgress}, Wallbox connected: ${this.wallboxConnected}, Car connected: ${this.currentCar.connected}, Car Soc: ${this.currentCar.soc}%, Charge - Limit: ${this.chargeLimit}% `);
		switch (this.chargeMode) {
			// ChargeMode 0: Deactivated, 1: Only-Surplus, 2: Minimal + Surplus, 3: Fast
			case 0:
				if (this.chargeInProgress) {
					this.log.info('Stopping active charging session!');
					this.stopWallbox();
				}
				break;
			case 1:
				/*
				if (this.currentSurplus > this.wallbox_ampere_min * 2) {
					this.log.info('Enough surplus: ${tmpSurplus} (${this.currentSurplus})!');
				}
					*/
				break;

			case 2:
				if (this.wallboxConnected) {

				}
				break;

			case 3:
				if (this.wallboxConnected && this.currentCar.connected) {
					// Not charging
					if (!this.chargeInProgress) {
						if (this.currentCar.soc != null && this.currentCar.soc < this.chargeLimit) {
							this.log.info(`Start charging 'Normal'! Car Soc: ${this.currentCar.soc}% | ChargeLimit: ${this.chargeLimit}% | Power: ${this.power}A`);

							// Set the power
							await this.setWallbox();

							// Start the Wallbox
							await this.startWallbox();
						} else {
							if (!this.chargeCompleted) {
								this.log.info(`Start of charging skipped.Car SoC ${this.currentCar.soc}% is equal / over ChargeLimit of ${this.chargeLimit}% !`);
								this.chargeCompleted = true;
								this.setInfoStates({
									charging: false,
									chargingCompleted: true,
									chargingDuration: 0,
									chargingPower: 0,
									chargingPercent: 0
								});
							}
						}
					}

					// Charging
					if (this.chargeInProgress) {
						// Check the Charge-Limit
						if (this.currentCar.soc >= this.chargeLimit) {
							this.log.info(`Car SoC of ${this.currentCar.soc}% reached ChargeLimit of ${this.chargeLimit}% !Stop charging!`);
							await this.stopWallbox();
						} else {
							// Get the car SoC
							await this.getCarSoc();
						}
					}
				}
				break;
		}

		// Calculate the time
		if (this.chargeInProgress) {
			this.calculateChargeTime();
		}
	}

	async stopWallbox() {
		if (this.wallbox_stop != '') {
			this.chargeInProgress = false;
			this.chargeCompleted = true;

			this.setInfoStates({
				charging: false,
				chargingCompleted: true,
				chargingDuration: 0,
				chargingPower: 0,
				chargingPercent: 0
			});

			this.log.info('Sending stop command to Wallbox!');
			this.setForeignStateAsync(this.wallbox_stop, true);
		} else {
			this.log.warn('Can not stop the Wallbox - no state defined!');
		}
	}

	setInfoStates(info) {
		const states = [
			{ key: 'info.charging', value: info.charging },
			{ key: 'info.chargingCompleted', value: info.chargingCompleted },
			{ key: 'info.chargeRemainingDuration', value: info.chargingDuration },
			{ key: 'info.chargeRemainingPower', value: info.chargingPower },
			{ key: 'info.chargeRemainingPercent', value: info.chargingPercent },
			{ key: 'info.vehicleName', value: info.vehicleName },
		];

		for (const state of states) {
			if (state.value !== undefined) {
				this.setStateChangedAsync(state.key, { val: state.value, ack: true });
			}
		}
	}

	async startWallbox() {
		if (this.wallbox_start != '') {
			this.chargeInProgress = true;
			this.chargeCompleted = false;

			this.setInfoStates({
				charging: true,
				chargingCompleted: false,
				chargingDuration: 0,
				chargingPower: 0,
				chargingPercent: 0
			});

			this.log.info('Sending start command to Wallbox!');
			this.setForeignStateAsync(this.wallbox_start, true);
		} else {
			this.log.warn('Can not start the Wallbox - no state defined!');
		}
	}

	async setWallbox() {
		if (this.config.wallbox_power != '') {
			if (!this.adapterIntervals.power) {
				await this.setWallboxPower();
				this.adapterIntervals.power = Date.now();
				this.log.info(`Setting timeout for wallbox - power to: ${this.timeout_power} seconds!`);
			} else {
				const elapsedTime = Date.now() - this.adapterIntervals.power;
				if (elapsedTime >= this.timeout_power * 1000) {
					await this.setWallboxPower();
					this.adapterIntervals.power = Date.now();;
				} else {
					this.log.info(`Can not set new value for power.Please wait: ${Math.floor(this.timeout_power - (elapsedTime / 1000))} seconds!`)
				}
			}

		} else {
			this.log.warn('Can not set power for the Wallbox - no state defined!');
		}
	}

	async calculateChargeTime() {
		if (this.currentCarConfig.capacity > 0) {
			const tmpWatt = this.getWattFromAmpere(this.power);
			const capacityInWh = this.currentCarConfig.capacity * 1000;

			// Calc left capacity of current SOC till chargeLimit
			const currentEnergyWh = capacityInWh * (this.currentCar.soc / 100);
			const targetEnergyWh = capacityInWh * (this.chargeLimit / 100);
			const energyToChargeWh = targetEnergyWh - currentEnergyWh;
			const remainingPercent = this.chargeLimit - this.currentCar.soc;

			// Calculate charging time in minutes
			const timeInMinutes = Math.round((energyToChargeWh / tmpWatt) * 60);

			this.setInfoStates({
				chargingDuration: timeInMinutes,
				chargingPower: this.power,
				chargingPercent: remainingPercent
			});
		}
	}

	async setWallboxPower() {
		const tmpAmpere = Math.min(Math.max(this.power, this.wallbox_ampere_min), this.wallbox_ampere_max);
		this.log.info(`Setting Wallbox Power to: ${tmpAmpere} Ampere!`);
		this.setForeignStateAsync(this.config.wallbox_power, tmpAmpere);
	}

	updateAllCars() {
		this.log.info('Requesting to update all cars!');
		for (let i = 0; i < this.availableCars.length; i++) {
			if (this.availableCars[i].update != '') {
				this.setForeignStateAsync(this.availableCars[i].update, true);
			}
		}
	}

	async getCarSoc() {
		if (this.currentCarConfig.soc != '') {
			// Check for car-request
			if (!this.adapterIntervals.car) {
				this.requestCarSoc();
				this.adapterIntervals.car = Date.now();
				this.log.info(`Setting refresh - timer for car to: ${this.timeout_car} seconds!`);
			} else {
				const elapsedTime = Date.now() - this.adapterIntervals.car;
				if (elapsedTime >= this.timeout_car * 1000) {
					this.requestCarSoc();
					this.adapterIntervals.car = Date.now();
				}
			}

			// Read the SoC state
			const tmpCarSoc = await this.getForeignStateAsync(this.currentCarConfig.soc);
			if (tmpCarSoc) {
				this.currentCar.soc = Number(tmpCarSoc.val);
			}
		} else {
			this.log.warn("You can not use the mode 'Normal charge' without having a state for the SoC of the car!");
			this.currentCar.soc = 0;
		}
	}

	requestCarSoc() {
		if (this.currentCarConfig.update != '') {
			this.log.info('Sending request to car state!');
			this.setForeignStateAsync(this.currentCarConfig.update, true);
		} else {
			this.log.warn('Can not request update from car as no Data point for Car Update is configured!');
		}
	}

	async checkPrerequisites() {
		// Car Soc below chargeLimit
		if (this.config.car_soc != '') {
			const tmpCarSoc = await this.getForeignStateAsync(this.car_soc);
			const tmpChargeLimit = tmpCarSoc ? tmpCarSoc.val < this.chargeLimit : true;

			this.log.info(`Checking Prerequisites: Car connected: ${this.wallboxConnected}, Car Soc belowChargeLimit: ${tmpChargeLimit} (Car: ${tmpCarSoc.val} | Limit: ${this.chargeLimit})!`);

			return this.wallboxConnected && tmpChargeLimit;
		} else {
			this.log.warn("You can not use the mode 'Normal charge (with ChargeLimit)' without having a state for the SoC of the car!");
			return false;
		}
	}

	/**
	 * Convert watt to ampere
	 * @param {number} watt - Power in Watt
	 * @returns {number} Ampere
	 */
	getAmpereFromWatt(watt) {
		return watt / 230;
	}
	/**
	 * Convert ampere to watt
	 * @param {number} ampere - Current in Ampere
	 * @returns {number} Watt
	 */
	getWattFromAmpere(ampere) {
		return ampere * 230;
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new chargecontrol(options);
} else {
	// otherwise start the instance directly
	new chargecontrol();
}