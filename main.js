'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

class PvSurplusChargingControl extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'pv-surplus-charging-control',
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
		this.car_capacity = 0;

		/* Internal Variables */
		this.wallboxConnected = false;
		this.currentSurplus = 0;
		this.surplusStart = null;
		this.surplusEnd = null;
		this.chargeInProgress = false;
		this.chargeCompleted = false;
		this.lastAction = null;
		this.chargeLimit = 0;
		this.ignoreChargeLimit = false;
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
			"1": "(1) Surplus (with ChargeLimit)",
			"2": "(2) Surplus (ignore ChargeLimit)",
			"3": "(3) Normal (with ChargeLimit)",
			"4": "(4) Normal (ignore ChargeLimit)"
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
		this.log.info("Starting PV Surplus Charging Control Adapter");

		// Surplus state
		if (this.config.surplus_id != '' && this.config.wallbox_connected != '') {
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
			this.car_capacity = this.config.car_capacity * 1000 || 0;
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

			configOK = true;
		} else {
			this.log.error("You need to enter a state for 'surplus' and 'wallbox connected' for the adapter to work!");
			configOK = false;
		}

		if (configOK) {
			// Own controls
			const subscribeArray = [`${this.namespace}.control.mode`, `${this.namespace}.control.chargeLimit`, `${this.namespace}.control.chargePower`];
			subscribeArray.push(this.config.wallbox_connected);
			subscribeArray.push(this.config.surplus_id);
			if (this.config.car_soc != '') {
				subscribeArray.push(this.config.car_soc);
			}

			this.subscribeForeignStatesAsync(subscribeArray);
			this.log.info("Requesting the following states: " + subscribeArray.toString());

			this.log.info('PV Surplus Charging Control Adapter started!');

			// Handle Charging
			this.manageCharging();
		} else {
			this.log.error("Adapter shutting down, as no state is entered for 'surplus'!");
			this.disable();
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
				// Car connected
				if (id == this.config.wallbox_connected) {
					// Set Wallbox connected
					this.wallboxConnected = state.val;
					this.log.info(`Car connetion changed: ${state.val ? 'connected' : 'disconnected'}`);
				}

				// Surplus
				if (id == this.config.surplus_id) {
					// Format it
					let tmpPower = this.surplus_option ? Number(state.val * 1000) : Number(state.val);

					// Set surplus
					this.currentSurplus = this.surplus_positive ? Math.max(0, tmpPower) : Math.abs(tmpPower);
				}

				// Car SoC
				if (id == this.config.car_soc) {
					this.carSoc = Number(state.val);
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
							this.log.info(`Charge-Power changed to: ${state.val}A!`);
							this.chargeCompleted = false;
							if (this.chargeInProgress) {
								await this.setWallbox();
							}
							break;
						case 'chargeLimit':
							this.chargeLimit = Number(state.val);
							this.log.info(`Charge-Limit changed to: ${state.val}%!`);
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
		this.log.info(`Charge-Log: Charge-Mode: ${this.chargeModes[this.chargeMode]}, Charge in progress: ${this.chargeInProgress}, Car connected: ${this.wallboxConnected}, Car Soc: ${this.carSoc}%, Charge-Limit: ${this.chargeLimit}% (Ignore Charge-Limit: ${this.ignoreChargeLimit})`);
		switch (this.chargeMode) {
			// ChargeMode 0: Deactivated, 1: Surplus (with ChargeLimit), 2: Surplus (ignore ChargeLimit), 3: Normal (with ChargeLimit), 4: Normal (ignore ChargeLimit)
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
				if (this.checkPrerequisites()) {
					if (!this.chargeInProgress) {
						this.log.info("All requirements for normal charge meet. Starting charge!");
						await this.startWallbox();
					}
				}
				break;

			case 3:
				if (this.wallboxConnected) {
					// Not charging
					if (!this.chargeInProgress) {
						this.ignoreChargeLimit = false;
						if (this.carSoc != null && this.carSoc < this.chargeLimit) {
							this.log.info(`Start charging 'Normal (with ChargeLimit)'! Car Soc: ${this.carSoc}% | ChargeLimit: ${this.chargeLimit}% | Power: ${this.power}A`);
							// Set the power
							await this.setWallbox();

							// Start the Wallbox
							await this.startWallbox();
						} else {
							if (!this.chargeCompleted) {
								this.log.info(`Start of charging skipped. Car SoC ${this.carSoc}% is equal/over ChargeLimit of ${this.chargeLimit}%!`);
								this.chargeCompleted = true;
							}
						}
					}

					// Charging
					if (this.chargeInProgress) {
						this.ignoreChargeLimit = false;

						// Check the Charge-Limit
						if (this.carSoc >= this.chargeLimit) {
							this.log.info(`Car SoC of ${this.carSoc}% reached ChargeLimit of ${this.chargeLimit}%! Stop charging!`);
							await this.stopWallbox();
						} else {
							// Get the car SoC
							await this.getCarSoc();
						}
					}
				}
				break;
			case 4:
				if (this.wallboxConnected) {
					if (!this.chargeInProgress) {
						this.log.info(`Start charging 'Normal (ignore ChargeLimit)'! Car Soc: ${this.carSoc}% ChargeLimit: ${this.chargeLimit}% (ignored)`);
						this.ignoreChargeLimit = true;
						await this.startWallbox();
					}

					if (this.chargeInProgress) {
						this.ignoreChargeLimit = true;
						// Stop Charge, if 100% reached
						if (this.carSoc == 100) {
							await this.stopWallbox();
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
		this.chargeInProgress = false;
		this.chargeCompleted = true;
		this.log.info('Sending stop command to Wallbox!');
		this.setForeignStateAsync(this.wallbox_stop, true);
	}

	async startWallbox() {
		this.chargeInProgress = true;
		this.chargeCompleted = false;
		this.log.info('Sending start command to Wallbox!');
		this.setForeignStateAsync(this.wallbox_start, true);
	}

	async setWallbox() {
		if (this.config.wallbox_power != '') {
			if (!this.adapterIntervals.power) {
				await this.setWallboxPower();
				this.adapterIntervals.power = Date.now();
				this.log.info(`Setting timeout for wallbox-power to: ${this.timeout_power} seconds!`);
			} else {
				const elapsedTime = Date.now() - this.adapterIntervals.power;
				if (elapsedTime >= this.timeout_power * 1000) {
					await this.setWallboxPower();
					this.adapterIntervals.power = null;
				} else {
					this.log.info(`Can not set new value for power. Please wait: ${Math.floor(this.timeout_power - (elapsedTime / 1000))} seconds!`)
				}
			}

		} else {
			this.log.warn('No Data point for Wallbox Power configured!');
		}
	}

	async calculateChargeTime() {
		if (this.car_capacity > 0) {
			const tmpWatt = this.getWattFromAmpere(this.power);
			const restCharge = (this.car_capacity) - ((this.car_capacity * this.carSoc) / 100);
			const time = Math.round((restCharge / tmpWatt) * 60);
			this.log.info('Rest: ' + time);
		}
	}

	async setWallboxPower() {
		const tmpAmpere = Math.min(Math.max(this.power, this.wallbox_ampere_min), this.wallbox_ampere_max);
		this.log.info(`Setting Wallbox Power to: ${tmpAmpere} Ampere!`);
		this.setForeignStateAsync(this.config.wallbox_power, tmpAmpere);
	}

	async getCarSoc() {
		if (this.config.car_soc != '') {
			// Check for car-request
			if (!this.adapterIntervals.car) {
				this.requestCarSoc();
				this.adapterIntervals.car = Date.now();
				this.log.info(`Setting refresh-timer for car to: ${this.timeout_car} seconds!`);
			} else {
				const elapsedTime = Date.now() - this.adapterIntervals.car;
				if (elapsedTime >= this.timeout_car * 1000) {
					this.requestCarSoc();
					this.adapterIntervals.car = null;
				}
			}

			// Read the SoC state
			const tmpCarSoc = await this.getForeignStateAsync(this.config.car_soc);
			if (tmpCarSoc) {
				this.carSoc = tmpCarSoc.val;
			}
		} else {
			this.log.warn("You can not use the mode 'Normal charge (with ChargeLimit)' without having a state for the SoC of the car!");
		}
	}

	requestCarSoc() {
		if (this.car_update != '') {
			this.log.info('Sending request to car state!');
			this.setForeignStateAsync(this.car_update, true);
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

	checkSurplusThreshold() {
		// Regulate Wallbox && check for Car-Update
		if (this.currentSurplus >= 0 && this.chargeInProgress) {
			// Regulate Wallbox

			// Request Update from Car
			if (this.car_update) {

			}

		}

		// General Start
		if (this.currentSurplus > this.wallbox_ampere_min * 2 && !this.chargeInProgress) {
			// If Charging is active, we can set the amperes and receive car updates
			if (this.chargeInProgress) {
				if (this.car_update) {
					this.setForeignStateAsync(this.car_update, true);
				} else {
					this.log.warn('No Data point for Car Update configured!');
				}
				const tmpAmpere = Math.floor(this.getAmpereFromWatt(this.currentSurplus));
				this.controlWallbox('power', tmpAmpere);
				this.lastAction = Date.now();
			}

			if (!this.surplusStart) {
				this.surplusStart = Date.now();
			} else {
				const elapsedTime = Date.now() - this.surplusStart;

				if (elapsedTime >= this.timeout_start * 1000) {
					this.controlWallbox('start');
				} else {
					this.log.info(`The surplus of ${this.currentSurplus} is higher than threshold of ${this.wallbox_ampere_min * 2}! This is since ${elapsedTime / 1000} seconds! Waiting ${this.timeout_start - (elapsedTime / 1000)} seconds to activate the Wallbox!`);
				}
			}
		}

		// General Stop
		if (this.currentSurplus < this.wallbox_ampere_min * 2) {
			if (!this.surplusEnd) {
				this.surplusEnd = Date.now();
			} else {
				const elapsedTime = Date.now() - this.surplusEnd;

				if (elapsedTime >= this.timeout_stop * 1000) {
					this.controlWallbox('stop');
				} else {
					this.log.info(`The surplus of ${this.currentSurplus} is lower than threshold of ${this.wallbox_ampere_min * 2}! This is since ${elapsedTime / 1000} seconds! Waiting ${this.timeout_stop - (elapsedTime / 1000)} seconds to deactivate the Wallbox!`);
				}
			}
		}
	}

	controlWallbox(mode, value = null) {
		if (this.isProtection()) {
			return;
		}

		switch (mode) {
			case 'start':
				this.log.info(`Starting the wallbox after ${this.timeout_start} seconds!`);
				//this.setStateAsync(this.wallbox_start, true);
				break;
			case 'stop':
				this.log.info(`Stopping the wallbox after ${this.timeout_stop} seconds!`);
				//this.setStateAsync(this.wallbox_stop, true);
				break;
			case 'power':
				if (this.wallbox_power && value) {
					const tmpAmpere = Math.min(Math.max(value, this.wallbox_ampere_min), this.wallbox_ampere_max);
					this.log.info(`Setting Wallbox Power to: ${tmpAmpere} Ampere!`);
				} else {
					this.log.warn('No Data point for Wallbox Power configured!');
				}
				break;
		}

		this.surplusStart = null;
		this.surplusEnd = null;
		this.chargeInProgress = true;

		// Timer for protection
		this.lastAction = Date.now();
	}


	isProtection() {
		if (Date.now() - this.lastAction >= this.timeout_protection * 1000) {
			this.lastAction = null;
			return false;
		}

		const protTimer = Math.floor(this.timeout_protection - (Date.now() - this.lastAction) / 1000);
		this.log.info(`Protection-Mode active for the next ${protTimer} seconds!`);

		return true;
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
	module.exports = (options) => new PvSurplusChargingControl(options);
} else {
	// otherwise start the instance directly
	new PvSurplusChargingControl();
}