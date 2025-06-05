const { RPCServer, createRPCError } = require('ocpp-rpc');
const { v4: uuidv4 } = require('uuid'); // Unique MessageId

const DEFAULT_CONNECTOR_ID = 1;
const DEFAULT_ID_TAG = 'iobcc';

// Save connected clients
let connectedClient = null;
let clientStatus = null;

const server = new RPCServer({
   protocols: ['ocpp1.6', 'ocpp2.0.1'], // server accepts ocpp protocol
   strictMode: true,       // enable strict validation of requests & responses
});

server.auth((accept, reject, handshake) => {
   // accept the incoming client
   accept({
      // anything passed to accept() will be attached as a 'session' property of the client.
      sessionId: uuidv4(), // Generate random session ID
   });
});

server.on('client', async (client) => {
   console.log(`${client.session.sessionId} connected!`);

   // Save the client
   connectedClient = client;

   // BootNotification requests
   client.handle('BootNotification', ({ params }) => {
      console.log(`Server got BootNotification from ${client.identity}:`, params);

      // respond to accept the client
      return {
         status: "Accepted",
         interval: 60,
         currentTime: new Date().toISOString()
      };
   });

   // Heartbeat requests
   client.handle('Heartbeat', async ({ params }) => {
      console.log(`Server got Heartbeat from '${client.identity}' at ${new Date().toLocaleString()}`, params);
      console.log('Current Wallbox Status: ', clientStatus);

      // Check, if Status is still preparing - then WB went offling during sending
      if (clientStatus && clientStatus.status == 'Preparing') {
         // Send the payload again
         const response = await sendCommand('SetChargingProfile', generateChargeProfile(0));
         console.log("ChargeProfile", response);

         if (response && response.status == 'Accepted') {
            // Start the Remote
            const response = await sendCommand('RemoteStartTransaction', { connectorId: DEFAULT_CONNECTOR_ID, idTag: DEFAULT_ID_TAG });
            console.log("RemoteTrans", response);
         }
      }


      // respond with the server's current time.
      return {
         currentTime: new Date().toISOString()
      };
   });

   // StopTransaction requests
   client.handle('StopTransaction', async ({ params }) => {
      console.log(`Server got StopTransaction from '${client.identity}' at ${new Date().toLocaleString()}`, params);

      // respond with the idTagInfo
      return {
         "idTagInfo": { "status": "Accepted" }
      };
   });

   // StartTransaction requests
   client.handle('StartTransaction', async ({ params }) => {
      console.log(`Server got StartTransaction from '${client.identity}' at ${new Date().toLocaleString()}`, params);

      // respond with the idTagInfo
      return {
         "idTagInfo": {
            "status": "Accepted"
         },
         "transactionId": 1
      };
   });

   // StatusNotification requests
   client.handle('StatusNotification', ({ params }) => {
      // Set the client status
      clientStatus = params;
      // Handle the current StatusNotification
      handleStatusNotification();
      return {};
   });

   // MeterValues
   client.handle('MeterValues', ({ params }) => {
      handleMeterValues(params?.meterValue);
      //getCurrentMaxAmp
      //console.log(`Server got MeterValues from ${client.identity}:`, JSON.stringify(params.meterValue));
      return {};
   })

   // Close requests
   client.handle('close', ({ params }) => {
      clientStatus = null;
      console.log(`Server got Close from ${client.identity}:`, params);
      return {};
   });

   // create a wildcard handler to handle any RPC method
   client.handle(({ method, params }) => {
      // This handler will be called if the incoming method cannot be handled elsewhere.
      console.log(`Server got ${method} from ${client.identity}:`, params);

      // throw an RPC error to inform the server that we don't understand the request.
      throw createRPCError("Not Implemented");
   });

   client.on('message', ({ message, outbound }) => {
      if (!message.includes('MeterValues')) {
         console.log(outbound ? '>>>' : '<<<', new Date().toLocaleString(), message);
      }
   });
});

async function handleStatusNotification() {
   if (clientStatus) {
      switch (clientStatus.status) {
         case 'Preparing': {
            console.log('Wallbox is preparing a new car!');

            // First put the car into pause mode and check requirements
            const response = await sendCommand('SetChargingProfile', generateChargeProfile(0));
            console.log("ChargeProfile", response);

            if (response && response.status == 'Accepted') {
               // Start the Remote
               const response = await sendCommand('RemoteStartTransaction', { connectorId: DEFAULT_CONNECTOR_ID, idTag: DEFAULT_ID_TAG });
               console.log("RemoteTrans", response);
            }
         }
            break;
         case 'Available': {
            console.log('Wallbox is ready!');
         }
            break;
         case 'SuspendedEV': {
            // Car is not requesting energy - perhaps awake?
            console.log('Suspended EV!');
         }
            break;

         case 'SuspendedEVSE': {
            console.log('Suspended by EVSE! Enabling charging for 10 seconds!');

            const response = await sendCommand('SetChargingProfile', generateChargeProfile(6));
            console.log("Suspended ChargeProfile", response);
            /*
                        if (response) {
                           // Start charging
                           /*
                           const response = await sendCommand('RemoteStartTransaction', { connectorId: DEFAULT_CONNECTOR_ID, idTag: DEFAULT_ID_TAG });
                           console.log("StartRemoteTrans", response);
                           */
            //}

         }
            break;
         case 'Charging': {
            /*
                        console.log('The car is charging! Trying to stop it!');
                        setTimeout(async () => {
                           const response = await sendCommand('SetChargingProfile', generateChargeProfile(0));
                           console.log(response);
                           if (response && response.status == 'Accepted') {
                              console.log('Wallbox stopped!');
                           } else {
                              console.log('Error while stoppoing the car!');
                           }
                        }, 10000);
                        */
         }
            break;

         case 'Finishing': {
            console.log('Finishing!', clientStatus);
         }
            break;
         default:
            console.log('Wallbox send and unhandled Status!', clientStatus);
            break;
      }
   }
}

/**
 * @param {number} amps
 */
function generateChargeProfile(amps) {
   const now = new Date();
   const timestamp = new Date(now.getTime() - 60 * 1000).toISOString(); // Reduce one minute
   console.log(timestamp);

   return {
      "connectorId": DEFAULT_CONNECTOR_ID,
      "csChargingProfiles": {
         "chargingProfileId": 10,
         "stackLevel": 3,
         "chargingProfilePurpose": "TxDefaultProfile",
         "chargingProfileKind": "Absolute",
         "chargingSchedule": {
            "startSchedule": timestamp,
            "chargingRateUnit": "A",
            "chargingSchedulePeriod": [
               {
                  "startPeriod": 0,
                  "limit": amps
               }]
         }
      }
   }
}

function handleMeterValues(values) {
   if (values) {

      const desiredMeasurands = ["Power.Offered", "Power.Active.Import", "Current.Offered"];

      values.forEach(entry => {
         console.log(JSON.stringify(entry.sampledValue));
         entry.sampledValue?.forEach(value => {
            if (desiredMeasurands.includes(value?.measurand)) {
               console.log("Gefundenes Element:", value);
            }
         });
      });
   }
}

function clearChargingProfile() {
   return {
      "chargingProfilePurpose": "TxDefaultProfile",
      "connectorId": DEFAULT_CONNECTOR_ID
   }
}

function getCurrentMaxAmp(values) {
   for (const measure of values) {
      console.log(measure);
   }
}

async function sendCommand(command, payload) {
   if (!connectedClient) {
      console.error('Kein Client gefunden!');
      return;
   }
   try {
      const response = await connectedClient.call(command, payload);
      console.log('Antwort des Clients:', response);
      return response;
   } catch (error) {
      console.error('Fehler beim Senden des Befehls ', command, error);
   }
}

try {
   let port = 10116;
   server.listen(port);
   console.log(`OCPP-Server started on ${port}! Waiting for a Wallbox to connect!`);
   const now = new Date();
   const timestamp = new Date(now.getTime() - 60 * 1000).toISOString(); // Reduce one minute
   console.log(timestamp);
}
catch (err) {
   console.error('Error while starting ')
}

//sendCommand('RemoteStartTransaction', { connectorId: DEFAULT_CONNECTOR_ID, idTag: DEFAULT_ID_TAG });