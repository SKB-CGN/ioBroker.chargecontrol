const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid'); // Unique MessageId
class OCPPServer {
   constructor(port) {
      this.port = 10116;
      this.server = null;
      this.stationId = null;
      this.connectedStations = new Map(); // Connected Stations including ws
      this.wallboxStates = new Map(); // Wallbox States
      this.requestedMeter = false;
      this.wallboxConfiguration = null;
      this.pendingMessages = new Map(); // Response Handler
      this.DEFAULT_CONNECTOR_ID = 1;
      this.DEFAULT_ID_TAG = 'iobcc';
   }

   start(port = 10116) {
      this.port = port;
      this.server = new WebSocket.Server({ port: this.port, perMessageDeflate: false });
      this.server.on('error', (ws, req) => {
         console.info(ws, req);
      })

      this.server.on('connection', (ws) => {
         // New connection
         this.stationId = uuidv4();
         this.connectedStations.set(this.stationId, ws);
         this.wallboxStates.set(this.stationId, {});

         console.log(`New Wallbox connected: ${this.stationId}`);

         // Messages
         ws.on('message', (message) => this.handleMessage(ws, message));

         // Disconnection
         ws.on('close', () => this.handleDisconnection(ws));

         // Errors
         ws.on('error', (error) => {
            console.error('WebSocket error:', error);
         });
      });

      // Heartbeat checker
      setInterval(() => {
         this.connectedStations.forEach((station, id) => {
            if (Date.now() - station.lastHeartbeat > 80 * 1000) { // Timeout 80 seconds
               console.log(`Wallbox ${id} hat Verbindung verloren.`);
               this.connectedStations.delete(id);
            }
         });
      }, 80 * 1000); // Check every 80 seconds

      console.log(`OCPP Server started on port ${this.port}. Waiting for connections ...`);
   }

   handleMessage(ws, message) {
      try {
         // Incoming message
         const msg = JSON.parse(message);

         console.log('Nachricht erhalten:', msg);
         // Parse message - OCPP messages are in JSON format
         const [messageType, messageId, action, payload] = msg;

         // Communication messages
         if (messageType === 2) {
            // Call Message
            this.handleCall(ws, messageId, action, payload);
         }

         // Call Result
         if (messageType === 3) {
            this.handleCallResult(ws, messageId, action, payload);
         }

         // Call Error
         if (messageType === 4) {
            this.handleError(ws, messageId, action, payload);
         }
      } catch (error) {
         console.error('Fehler beim Parsen der Nachricht:', error);
      }
   }

   handleCallResult(ws, messageId, action, payload) {
      console.log(`Trying to find Result message for ${messageId}`);
      if (this.pendingMessages.has(messageId)) {
         const { resolve, reject } = this.pendingMessages.get(messageId);
         console.log(`Handling resolve for ${messageId} with result ${JSON.stringify(action)}`);
         resolve(action);

         this.pendingMessages.delete(messageId);
      }
   }

   handleError(ws, messageId, action, payload) {
      console.log(`Trying to find Error message for ${messageId}`);
      if (this.pendingMessages.has(messageId)) {
         const { resolve, reject } = this.pendingMessages.get(messageId);
         console.log(`Handling reject for ${messageId} with result ${JSON.stringify(action)}`);
         reject(new Error(`CallError: ${action} - ${payload}`));

         this.pendingMessages.delete(messageId);
      }
   }

   async handleCall(ws, messageId, action, payload) {
      const defaultAccepted = JSON.stringify([3, messageId, { status: 'Accepted' }]);
      if (action === 'BootNotification') {
         // New connection
         this.stationId = uuidv4();
         this.connectedStations.set(this.stationId, ws);
         this.wallboxStates.set(this.stationId, {});

         console.log(`New Wallbox connected: ${this.stationId}`);

         console.log(`BootNotification von ${this.stationId}`);
         ws.send(JSON.stringify([3, messageId, { status: 'Accepted', currentTime: new Date().toISOString(), interval: 60 }]));
      }

      // Heartbeat
      if (action === 'Heartbeat') {
         // Wallbox is not online before first heartbeat received
         this.wallboxStates.get(this.stationId).online = this.wallboxStates.get(this.stationId).lastHeartbeat ? true : false;

         this.wallboxStates.get(this.stationId).lastHeartbeat = Date.now();
         ws.send(JSON.stringify([3, messageId, { currentTime: new Date().toISOString() }]));
         console.log("Confirm Heartbeat " + Date().toLocaleString());

         setTimeout(async () => {
            try {
               console.log('Sending request to start');
               await this.reservation();
            }
            catch (error) {
               console.error(error);
            }

            try {
               // Get Config
               console.log('Sending request to stop!');
               const response = await this.stopCharging();
               console.log("Config: " + response);
            } catch (error) {
               console.error(error);
            }

         }, 10000);
      }

      // Status Notification
      if (action === 'StatusNotification') {
         console.log(`StatusNotification von ${this.stationId}`);
         // Set the status of the station
         this.wallboxStates.get(this.stationId).status = payload.status;
         this.wallboxStates.get(this.stationId).error = payload.errorCode;
         ws.send(defaultAccepted);

         // Get the configuration after first status notification
         if (!this.wallboxConfiguration) {
            // Get the configuration
            //this.wallboxConfiguration = await this.getConfiguration();
            console.info(this.wallboxConfiguration);
            //this.getConfiguration();
         }
         //sendServerCommand(stationId, "RemoteStartTransaction", { idTag: "ChargeControl", "connectorId": 1 });
         /*
         Status "Preparing" -> Auto wird angeschlossen
         Status "SuspendedEV" -> Auto angeschlossen
         Status "Finishing" -> Auto wird abgeschaltet

         */
      }

      // Start Transaction
      if (action === 'StartTransaction') {
         ws.send(defaultAccepted);
      }

      // Stop Transaction
      if (action === 'StopTransaction') {
         console.log(`StopTransaction von ${this.stationId}`);
         ws.send(defaultAccepted);
      }

      // Meter Values
      if (action === 'MeterValues') {
         console.log(`MeterValues of ${this.stationId} received!`);
         this.wallboxStates.get(this.stationId).meterValues = JSON.stringify(payload.meterValue);
         //console.log(this.wallboxStates.get(this.stationId).meterValues);
         ws.send(defaultAccepted);
      }
   }

   // Disconnections
   handleDisconnection(ws) {
      console.log('Verbindung geschlossen!');
      for (let [id, connection] of this.connectedStations.entries()) {
         if (connection === ws) {
            this.connectedStations.delete(id);
            this.wallboxStates.delete(id);
            console.log(`Wallbox ${id} disconnected!`);
            break;
         }
      }
   }

   sendMessage(action, payload) {
      return new Promise((resolve, reject) => {
         try {
            const ws = this.connectedStations.get(this.stationId);

            if (!ws && ws.readyState !== WebSocket.OPEN) {
               reject(new Error(`Wallbox ${this.stationId} is not connected!`));
            }

            const messageId = uuidv4(); // Unique ID for message
            const message = [2, messageId, action, payload];

            // Save the promise to messages
            this.pendingMessages.set(messageId, { resolve, reject });

            console.log("Sending message to wallbox: ", message);

            ws.send(JSON.stringify(message));

            setTimeout(() => {
               if (this.pendingMessages.has(messageId)) {
                  //this.pendingMessages.delete(messageId);
                  console.log(`Deleting message ${messageId} after timeout!`);
                  reject(new Error(`Timeout for command ${action}! No answer from Wallbox!`));
               }
            }, 30 * 1000); // 30 seconds timeout
         } catch (error) {
            reject(error);
         }
      });
   }

   status() {
      return {
         wallboxStates: this.wallboxStates
      };
   }

   async startTransaction() {
      try {
         const response = await this.sendMessage("Authorize", { idTag: this.DEFAULT_ID_TAG });
         console.log("Authorize Response:", response);
         return response;
      }

      catch (error) {
         console.error('Error during authorization!', error);
      }
   }

   async getConfiguration() {
      try {
         const response = await this.sendMessage("GetConfiguration", {});
         console.log("GetConfig Response:", response);
         return response;
      }
      catch (error) {
         console.error('Error while getting the config!', error);
      }
   }

   requestMeter() {
      this.sendMessage("TriggerMessage", { requestedMessage: "MeterValues", "connectorId": 1 });
   }

   async startCharging() {
      try {
         const response = await this.sendMessage("RemoteStartTransaction", { idTag: this.DEFAULT_ID_TAG, "connectorId": this.DEFAULT_CONNECTOR_ID });
         console.log("RemoteStart Response:", response);
         return response;
      }

      catch (error) {
         console.error('Error during authorization!', error);
         throw error;
      }
   }

   async stopCharging() {
      try {
         const response = await this.sendMessage("RemoteStopTransaction", { transactionId: 1 });
         return response;
      } catch (error) {
         console.error('Error while stopping the charge!', error);
         throw error;
      }
   }

   unlock() {
      this.sendMessage("UnlockConnector", { "connectorId": this.DEFAULT_CONNECTOR_ID });
   }

   async reservation() {
      try {
         const currentDate = new Date();
         currentDate.setHours(currentDate.getHours() + 1);
         const response = await this.sendMessage("Reservation", { "connectorId": this.DEFAULT_CONNECTOR_ID, "expiryDate": currentDate.toISOString() });
         console.log("Authorize Response:", response);
         return response;
      }
      catch (error) {
         console.error('Error during authorization!', error);
         throw error;
      }
   }

   async authorize() {
      try {
         const response = await this.sendMessage("Authorize", { "idTag": this.DEFAULT_ID_TAG });
         console.log("Authorize Response:", response);
         return response;
      }
      catch (error) {
         console.error('Error during authorization!', error);
         throw error;
      }
   }

   async setAmpere(ampere) {
      try {
         const chargeProfile =
         {
            connectorId: this.DEFAULT_CONNECTOR_ID,
            csChargingProfiles: {
               chargingProfileId: 1,
               transactionId: 1,
               stackLevel: 0,
               chargingProfilePurpose: "TxProfile", // TxProfile used for the current transaction
               chargingProfileKind: "Relative",
               chargingSchedule: {
                  chargingRateUnit: "A",
                  chargingSchedulePeriod: [
                     {
                        startPeriod: 0,
                        limit: 6
                     }
                  ]
               }
            }
         }
         /*
         {
            "connectorId": 1,
            "csChargingProfiles": {
               "chargingProfileId": 1,
               "stackLevel": 0,
               "chargingProfilePurpose": "TxProfile",
               "chargingProfileKind": "Absolute",
               "chargingSchedule": {
                  "chargingRateUnit": "A", // Ampere
                  "chargingSchedulePeriod": [
                     {
                        "startPeriod": 0,
                        "limit": 32 // Max Ampere
                     }
                  ]
               }
            }
         };
         */
         const response = await this.sendMessage("SetChargingProfile", chargeProfile);
         return response;
      } catch (error) {
         console.error('Error while setting ampere!', error);
         throw error;
      }
   }
}

// Start the server
const server = new OCPPServer();
server.start(10116);