'use strict';

const state = {
   status: {
      common: {
         name: {
            "en": "Status",
            "de": "Status",
            "ru": "Статус",
            "pt": "Estado",
            "nl": "Status",
            "fr": "Statut",
            "it": "Stato",
            "es": "Estado",
            "pl": "Status",
            "uk": "Статус",
            "zh-cn": "Status"
         },
         desc: {
            "en": "Current status of wallbox",
            "de": "Aktueller Status der Wallbox",
            "ru": "Текущее состояние wallbox",
            "pt": "Estado atual da Wallbox",
            "nl": "Huidige status van wallbox",
            "fr": "Statut actuel de la wallbox",
            "it": "Stato attuale della wallbox",
            "es": "Estado actual de la Wallbox",
            "pl": "Aktualny stan wallboxa",
            "uk": "Поточний стан зарядного пристрою",
            "zh-cn": "Current status of wallbox"
         },
         type: "string",
         role: "indicator.status",
         write: false,
         read: true,
         states: [
            "Available",
            "Preparing",
            "Charging",
            "SuspendedEVSE",
            "SuspendedEV",
            "Finishing",
            "Reserved",
            "Unavailable",
            "Faulted"
         ]
      }
   },
   connected: {
      common: {
         name: {
            "en": "OCPP connected",
            "de": "OCPP angeschlossen",
            "ru": "OCPP подключен",
            "pt": "OCPP ligado",
            "nl": "OCPP aangesloten",
            "fr": "OCPP connecté",
            "it": "OCPP collegato",
            "es": "OCPP conectado",
            "pl": "OCPP podłączony",
            "uk": "Підключено OCPP",
            "zh-cn": "OCPP connected"
         },
         desc: {
            "en": "Wallbox currently connected via OCPP",
            "de": "Wallbox derzeit über OCPP verbunden",
            "ru": "Настенный блок в настоящее время подключен через OCPP",
            "pt": "Wallbox atualmente ligada via OCPP",
            "nl": "Wallbox momenteel aangesloten via OCPP",
            "fr": "Wallbox actuellement connectée via OCPP",
            "it": "Wallbox attualmente collegato tramite OCPP",
            "es": "Wallbox actualmente conectada a través de OCPP",
            "pl": "Stacja Wallbox aktualnie połączona przez OCPP",
            "uk": "Наразі зарядний пристрій Wallbox підключено через OCPP",
            "zh-cn": "Wallbox currently connected via OCPP"
         },
         type: 'boolean',
         role: 'indicator.status',
         read: true,
         write: false,
         def: false
      }
   },
   heartbeat: {
      common: {
         name: {
            "en": "Heartbeat",
            "de": "Herzschlag",
            "ru": "Сердцебиение",
            "pt": "Batimento cardíaco",
            "nl": "Hartslag",
            "fr": "Rythme cardiaque",
            "it": "Battito del cuore",
            "es": "Latido del corazón",
            "pl": "Bicie serca",
            "uk": "Серцебиття",
            "zh-cn": "Heartbeat"
         },
         desc: {
            "en": "Last heartbeat of the connected client",
            "de": "Letzter Heartbeat des verbundenen Clients",
            "ru": "Последнее сердцебиение подключенного клиента",
            "pt": "Último batimento cardíaco do cliente ligado",
            "nl": "Laatste heartbeat van de verbonden client",
            "fr": "Dernier battement de cœur du client connecté",
            "it": "Ultimo battito cardiaco del client collegato",
            "es": "Último latido del cliente conectado",
            "pl": "Ostatnie uderzenie serca połączonego klienta",
            "uk": "Останнє серцебиття підключеного клієнта",
            "zh-cn": "Last heartbeat of the connected client"
         },
         type: 'string',
         role: 'date',
         read: true,
         write: false,
         def: ''
      }
   },
   client: {
      common: {
         name: {
            "en": "Connected wallbox",
            "de": "Angeschlossene Wallbox",
            "ru": "Подключенная настенная коробка",
            "pt": "Caixa de parede ligada",
            "nl": "Aangesloten wallbox",
            "fr": "Boîte murale connectée",
            "it": "Scatola a muro collegata",
            "es": "Caja mural conectada",
            "pl": "Podłączona stacja ładowania",
            "uk": "Підключена настінна коробка",
            "zh-cn": "Connected wallbox"
         },
         desc: {
            "en": "Name of the current connected client connected via OCPP",
            "de": "Name des aktuell verbundenen Clients, der über OCPP verbunden ist",
            "ru": "Имя текущего подключенного клиента, подключенного через OCPP",
            "pt": "Nome do atual cliente ligado através de OCPP",
            "nl": "Naam van de huidige verbonden client verbonden via OCPP",
            "fr": "Nom du client actuellement connecté via OCPP",
            "it": "Nome del client collegato correntemente tramite OCPP",
            "es": "Nombre del cliente conectado actualmente a través de OCPP",
            "pl": "Nazwa aktualnie podłączonego klienta połączonego przez OCPP",
            "uk": "Ім'я поточного підключеного клієнта, підключеного через OCPP",
            "zh-cn": "Name of the current connected client connected via OCPP"
         },
         type: 'string',
         role: 'info.name',
         read: true,
         write: false,
         def: ''
      }
   },
   chargePower: {
      common: {
         name: {
            "en": "Power of charging",
            "de": "Leistung der Aufladung",
            "ru": "Мощность зарядки",
            "pt": "Potência de carga",
            "nl": "Oplaadvermogen",
            "fr": "Puissance de charge",
            "it": "Potenza di carica",
            "es": "Poder de carga",
            "pl": "Moc ładowania",
            "uk": "Потужність зарядки",
            "zh-cn": "Power of charging"
         },
         desc: {
            "en": "Current charging power of the wallbox",
            "de": "Aktuelle Ladeleistung der Wallbox",
            "ru": "Текущая мощность зарядки настенного блока",
            "pt": "Potência de carga atual da Wallbox",
            "nl": "Huidig laadvermogen van de wallbox",
            "fr": "Puissance de charge actuelle de la wallbox",
            "it": "Potenza di carica attuale della wallbox",
            "es": "Potencia de carga actual de la Wallbox",
            "pl": "Aktualna moc ładowania stacji ładowania Wallbox",
            "uk": "Поточна потужність заряджання зарядного пристрою",
            "zh-cn": "Current charging power of the wallbox"
         },
         type: 'number',
         role: 'value.power.active',
         read: true,
         write: false,
         unit: 'W',
         def: 0
      }
   },
   chargeCurrent: {
      common: {
         name: {
            "en": "Charging current",
            "de": "Ladestrom",
            "ru": "Ток зарядки",
            "pt": "Corrente de carga",
            "nl": "Laadstroom",
            "fr": "Courant de charge",
            "it": "Corrente di carica",
            "es": "Corriente de carga",
            "pl": "Prąd ładowania",
            "uk": "Зарядний струм",
            "zh-cn": "Charging current"
         },
         desc: {
            "en": "Provided current of the wallbox",
            "de": "Bereitgestellter Strom der Wallbox",
            "ru": "Предусмотренный ток настенного ящика",
            "pt": "Corrente fornecida da Wallbox",
            "nl": "Geleverde stroom van de wallbox",
            "fr": "Courant fourni par la wallbox",
            "it": "Corrente fornita dalla wallbox",
            "es": "Corriente suministrada de la Wallbox",
            "pl": "Prąd dostarczany przez stację ładowania",
            "uk": "Забезпечений струм зарядного пристрою",
            "zh-cn": "Provided current of the wallbox"
         },
         type: 'number',
         role: 'value.current',
         read: true,
         write: false,
         unit: 'A',
         def: 0
      }
   },
   session: {
      common: {
         name: {
            "en": "Session charging power",
            "de": "Ladeleistung der Sitzung",
            "ru": "Мощность зарядки сеанса",
            "pt": "Potência de carregamento da sessão",
            "nl": "Sessie laadvermogen",
            "fr": "Puissance de charge de la session",
            "it": "Potenza di carica della sessione",
            "es": "Potencia de carga de la sesión",
            "pl": "Moc ładowania sesji",
            "uk": "Потужність сеансу заряджання",
            "zh-cn": "Session charging power"
         },
         desc: {
            "en": "Current charging power of the charging session",
            "de": "Aktuelle Ladeleistung des Ladevorgangs",
            "ru": "Текущая мощность зарядки в сеансе зарядки",
            "pt": "Potência de carga atual da sessão de carregamento",
            "nl": "Huidig laadvermogen van de laadsessie",
            "fr": "Puissance de charge actuelle de la session de charge",
            "it": "Potenza di carica attuale della sessione di carica",
            "es": "Potencia de carga actual de la sesión de carga",
            "pl": "Aktualna moc ładowania podczas sesji ładowania",
            "uk": "Поточна потужність заряджання під час сеансу заряджання",
            "zh-cn": "Current charging power of the charging session"
         },
         type: 'number',
         role: 'value.power.active',
         read: true,
         write: false,
         unit: 'Wh',
         def: 0
      }
   }
}

module.exports = {
   state
};