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
		this.currentAmp = 0;
		this.requestAmp = 0;
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
		this.on('message', this.onMessage.bind(this));
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
			const tmpAmpere = await this.getStateAsync('control.chargeAmpere');

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
			this.currentAmp = tmpAmpere.val;
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
					if (this.wallboxConnected && this.currentCarConfig.length == 0 && this.availableCars[i].connected != '') {
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
			this.setInfoStates({ vehicleName: this.currentCarConfig.name || 'No car connected!', vehicleSoc: this.currentCar.soc });


			if (this.config.surplus_id != '') {
				subscribeArray.push(this.config.surplus_id);
			}

			this.log.info('Notifications: ' + this.config.notificationsType + ' ' + this.config.telegramInstance + ' ' + this.config.telegramRecipient);

			this.subscribeForeignStatesAsync(subscribeArray);
			this.log.info("Requesting the following states: " + subscribeArray.toString());

			this.log.info('ChargeControl Adapter started!');

			// Handle Charging
			this.manageCharging();
		} else {
			this.log.error("Adapter shutting down, as no state is entered for 'wallbox connected'!");
			await this.stop?.({ exitCode: 11, reason: 'invalid config' });
			return;
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
			this.log.info(`Adapter ChargeControl cleaned up everything ...`);
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
						this.setInfoStates({
							vehicleName: 'Identifying car'
						});

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
						// Update Info
						this.setInfoStates({
							vehicleName: '',
							vehicleSoc: 0
						});

						// Reset mode
						this.resetFinished();
					}
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
						this.setInfoStates({
							vehicleSoc: this.currentCar.soc
						});
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

							// Reset charging completed, to check the new modes
							this.chargeCompleted = false;
							this.setInfoStates({
								chargingCompleted: false
							})
							break;
						case 'chargeAmpere':
							this.requestAmp = Number(state.val);
							this.log.info(`Charge - Ampere changed to: ${state.val}A!`);
							if (this.chargeInProgress) {
								await this.setWallbox(true);
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
				} else {
					// Surplus
					if (id == this.config.surplus_id) {
						// Format it
						let tmpPower = this.surplus_option ? Number(state.val * 1000) : Number(state.val);

						// Set surplus
						this.currentSurplus = this.surplus_positive ? Math.max(0, tmpPower) : Math.abs(tmpPower);
					}
				}
			}

			// Handle Charging
			this.manageCharging();
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
													value: userList[i].firstName ? userList[i].firstName : userList[i].userName,
													label: userList[i].firstName ? userList[i].firstName : userList[i].userName
												});
											}
											this.sendTo(obj.from, obj.command, targets, obj.callback);
											this.log.debug(obj.command + ': ' + JSON.stringify(targets));
										} else {
											this.sendTo(obj.from, obj.command, [{ label: 'Not available', value: '' }], obj.callback);
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
	async manageCharging() {
		this.log.debug(`Charge - Log: Charge - Mode: ${this.chargeModes[this.chargeMode]}, Charge in progress: ${this.chargeInProgress}, Wallbox connected: ${this.wallboxConnected}, Car connected: ${this.currentCar.connected}, Car Soc: ${this.currentCar.soc}%, Charge - Limit: ${this.chargeLimit}% `);
		switch (this.chargeMode) {
			// ChargeMode 0: Deactivated, 1: Only-Surplus, 2: Minimal + Surplus, 3: Fast
			case 0:
				if (this.chargeInProgress) {
					this.log.info('Stopping active charging session!');
					this.stopWallbox();
				} else {
					this.setInfoStates({
						charging: false,
						chargingCompleted: false,
						chargingDuration: 0,
						chargingPower: 0,
						chargingPercent: 0
					});
				}
				break;
			case 1:
				if (this.wallboxConnected && this.currentCar.connected) {
					// Charging in Progress - regulate the Wallbox
					const minSurplus = this.getWattFromAmpere(this.wallbox_ampere_min);

					if (this.chargeInProgress) {

						this.log.info(`Current surplus: ${this.currentSurplus} (+ Wallbox usage: ${this.getWattFromAmpere(this.currentAmp)}) | Minimal needed suplus: ${minSurplus}`);

						// Check the Charge-Limit
						if (this.currentCar.soc >= this.chargeLimit) {
							this.log.info(`Car SoC of ${this.currentCar.soc}% reached ChargeLimit of ${this.chargeLimit}% ! Stop charging!`);
							await this.stopWallbox();
						} else {
							// Get the car SoC
							await this.getCarSoc();

							// Surplus Rest-Ampere
							const restAmp = Math.floor(this.getAmpereFromWatt(Math.abs(this.currentSurplus)));

							// Surplus is still enough - proceed
							if (this.currentSurplus > 0) {
								// Can Wallbox be raised?
								if (this.currentAmp + restAmp <= this.wallbox_ampere_max) {
									this.requestAmp = this.currentAmp + restAmp;

									this.log.info(`Requesting to regulate the Wallbox to: ${this.requestAmp}A`);

									// Set the Wallbox
									this.setWallbox();
								}
							}

							// Surplus is negative - try to regulate the wallbox
							if (this.currentSurplus < 0) {
								// Can Wallbox be lowered?
								if (this.currentAmp - restAmp >= this.wallbox_ampere_min) {
									this.requestAmp = this.currentAmp - restAmp;

									// Set the Wallbox
									this.setWallbox();

									// Stopping not necessary
									this.adapterIntervals.stop = null;
								} else {
									// Already at lowest Amps?
									if (this.currentAmp == this.wallbox_ampere_min) {
										// Activate Stop Timeout
										if (!this.adapterIntervals.stop) {
											this.adapterIntervals.stop = Date.now();
											this.log.info(`Setting timeout for stopping the wallbox: ${this.timeout_stop} seconds!`);
										} else {
											const elapsedTime = Date.now() - this.adapterIntervals.stop;
											if (elapsedTime >= this.timeout_stop * 1000) {
												// No chance during timeOut - need to stop
												this.stopWallbox();

												this.adapterIntervals.stop = null; // Reset the timer for next stop
											}
										}
									} else {
										// Give it another try
										this.requestAmp = this.wallbox_ampere_min;

										// Set the Wallbox
										this.setWallbox();
									}
								}
							}
						}
					}

					// Charging not in progress - check prerequisites to start charging
					if (!this.chargeInProgress) {
						if (this.currentCar.soc != null && this.currentCar.soc < this.chargeLimit) {
							this.log.info(`Start charging 'Surplus'! Car Soc: ${this.currentCar.soc}% | ChargeLimit: ${this.chargeLimit}% | Ampere: ${this.currentAmp}A`);
							if (this.currentSurplus > minSurplus) {
								this.log.info(`Current surplus is high enough.`);
								if (!this.adapterIntervals.start) {
									this.adapterIntervals.start = Date.now();
									this.log.info(`Setting timeout for starting the wallbox: ${this.timeout_start} seconds!`);
								} else {
									const elapsedTime = Date.now() - this.adapterIntervals.start;
									if (elapsedTime >= this.timeout_start * 1000) {
										// Calculate the current Power for Wallbox
										this.requestAmp = Math.floor(this.getAmpereFromWatt(this.currentSurplus));
										this.log.info(`Requesting ${this.requestAmp}A for Wallbox!`);

										// Set the Wallbox
										this.setWallbox();

										// Start the Wallbox
										this.startWallbox();

										this.adapterIntervals.start = null; // Reset the timer for next start
									} else {
										this.log.info(`Waiting ${Math.floor(this.timeout_start - (elapsedTime / 1000))} seconds to start the wallbox!`);
									}
								}
							}
						} else {
							if (!this.chargeCompleted) {
								this.log.info(`Start of charging skipped! Car SoC ${this.currentCar.soc}% is equal / over ChargeLimit of ${this.chargeLimit}% !`);
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
				}

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
							this.log.info(`Start charging 'Normal'! Car Soc: ${this.currentCar.soc}% | ChargeLimit: ${this.chargeLimit}% | Ampere: ${this.currentAmp}A`);

							// Set the power
							this.requestAmp = this.wallbox_ampere_max;
							await this.setWallbox();

							// Start the Wallbox
							await this.startWallbox();
						} else {
							if (!this.chargeCompleted) {
								this.log.info(`Start of charging skipped! Car SoC ${this.currentCar.soc}% is equal / over ChargeLimit of ${this.chargeLimit}% !`);
								this.chargeCompleted = true;
								this.setInfoStates({
									charging: false,
									chargingCompleted: true,
									chargingDuration: 0,
									chargingPower: 0,
									chargingPercent: 0
								});

								// Reset mode
								this.resetFinished();
							}
						}
					}

					// Charging
					if (this.chargeInProgress) {
						// Check the Charge-Limit
						if (this.currentCar.soc >= this.chargeLimit) {
							this.log.info(`Car SoC of ${this.currentCar.soc}% reached ChargeLimit of ${this.chargeLimit}% ! Stop charging!`);
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

			// Reset mode
			this.resetFinished();

			this.log.info('Sending stop command to Wallbox!');
			this.setForeignStateAsync(this.wallbox_stop, true);
		} else {
			this.log.warn('Can not stop the Wallbox - no state defined!');
		}
	}

	resetFinished() {
		// If reset to finished, change the mode to surplus
		if (this.chargeMode != 0 && this.config.resetFinished) {
			this.log.info('Resetting the mode to "Only Surplus"!');
			this.setStateAsync('control.mode', 1);
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
			{ key: 'info.vehicleSoc', value: info.vehicleSoc }
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

			// Notification
			this.sendNotification();
		} else {
			this.log.warn('Can not start the Wallbox - no state defined!');
		}
	}

	sendNotification() {
		if (this.config.notificationEnable) {
			switch (this.config.notificationsType) {
				case 'Telegram':
					if (this.config.telegramRecipient && this.config.telegramRecipient === 'allTelegramUsers') {
						this.sendTo(this.config.telegramInstance, 'send', { text: 'ChargeControl:\nStarting to charge!', disable_notification: this.config.telegramSilentNotice });
					} else {
						this.sendTo(this.config.telegramInstance, 'send', { user: this.config.telegramRecipient, text: 'ChargeControl:\nStarting to charge!', disable_notification: this.config.telegramSilentNotice });
					}
					break;
				case 'E-Mail':
					// Include later
					break;
			}
		}
	}

	async setWallbox(user = false) {
		if (this.config.wallbox_power != '') {
			if (!this.adapterIntervals.power) {
				await this.setWallboxAmpere();
				this.adapterIntervals.power = Date.now();
				this.log.info(`Setting timeout for wallbox - power to: ${this.timeout_power} seconds!`);
			} else {
				const elapsedTime = Date.now() - this.adapterIntervals.power;
				if (elapsedTime >= this.timeout_power * 1000) {
					await this.setWallboxAmpere();
					this.adapterIntervals.power = Date.now();
				} else {
					if (user) {
						this.log.warn(`Can not set new value for Ampere! Please wait ${Math.floor(this.timeout_power - (elapsedTime / 1000))} seconds! And retry!`)
					}
				}
			}

		} else {
			this.log.warn('Can not set power for the Wallbox - no state defined!');
		}
	}

	async setWallboxAmpere() {
		this.currentAmp = Math.min(Math.max(this.requestAmp, this.wallbox_ampere_min), this.wallbox_ampere_max);
		this.log.info(`Setting Wallbox Power to: ${this.currentAmp} Ampere!`);
		//await this.setForeignStateAsync(this.config.wallbox_power, this.currentAmp);
	}

	updateAllCars() {
		this.log.info('Requesting to update all cars!');
		for (let i = 0; i < this.availableCars.length; i++) {
			if (this.availableCars[i].update != '') {
				this.setForeignStateAsync(this.availableCars[i].update, true);
			}
		}
	}

	calculateChargeTime() {
		if (this.currentCarConfig.capacity > 0) {
			const tmpWatt = this.getWattFromAmpere(this.currentAmp);
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
				chargingPower: energyToChargeWh,
				chargingPercent: remainingPercent
			});
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