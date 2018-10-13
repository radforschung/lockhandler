try {
	require("dotenv").config();
} catch (e) {
	// dotenv is only installed and needed for dev
}

const ttn = require("ttn");
const express = require("express");
const fs = require("fs");
const mls = require("mls");

const PORT = process.env.PORT || 3000;
const STATE_PATH = process.env.STATE_PATH || "locks.json";
const TTN_APP_ID = process.env.TTN_APP_ID;
const TTN_ACCESS_KEY = process.env.TTN_ACCESS_KEY;
const MLS_API_KEY = process.env.MLS_API_KEY;

if (
	typeof TTN_APP_ID === "undefined" ||
	typeof TTN_ACCESS_KEY === "undefined" ||
	typeof MLS_API_KEY === "undefined"
) {
	console.error(
		"please set the env variables TTN_APP_ID, TTN_ACCESS_KEY and MLS_API_KEY"
	);
	process.exit(1);
}

const toHex = i => (i < 0x10 ? "0" : "") + i.toString(16);

const mozlocation = new mls(MLS_API_KEY);
const app = express();
app.set("view engine", "ejs");

let locks;
let lockQueue = [];
let client;
let log = [];

try {
	locks = JSON.parse(fs.readFileSync(STATE_PATH));
} catch (e) {
	locks = [];
}

const dumpLocks = () => {
	console.log("#", "writing locks state");
	try {
		fs.writeFileSync(STATE_PATH, JSON.stringify(locks));
	} catch (e) {
		console.log("!", "couldn't write locks file:", e);
	}
};
process.on("exit", dumpLocks);
process.on("SIGINT", process.exit);

(async () => {
	// https://www.thethingsnetwork.org/docs/applications/nodejs/api.html#dataclient
	// TODO: research: check if connection aborts, reconnect? already supported by the lib?
	client = await ttn.data(TTN_APP_ID, TTN_ACCESS_KEY);
	console.log("connected to ttn");

	client.on("uplink", function(device_id, payload) {
		console.log("Received uplink from ", device_id);
		console.log(payload);
		log.push({
			time: new Date(),
			device: device_id,
			type: "received",
			payload: payload
		});

		let lock = locks.find(l => l.id === device_id);
		if (typeof lock === "undefined") {
			lock = {
				id: device_id,
				hardware_serial: payload.hardware_serial,
				state: null,
				last_seen: null,
				location: {}
			};
			locks.push(lock);
		}

		// send downlink if we have some in our queue
		if (typeof lockQueue[lock.id] !== "undefined" && lockQueue[lock.id].length > 0) {
			lockQueue[lock.id] = lockQueue[lock.id].filter((item) => {
				if (+(new Date()) > item.timeout) {
					log.push({
						time: new Date(),
						device: lock.id,
						type: "timeout",
						created: item.created,
						timeout: item.timeout,
						payload: item.data,
						port: item.port,
						confirmed: item.confirmed
					});
				    return false; // remove item
				}

				client.send(lock.id, item.data, item.port, item.confirmed, "last");
				log.push({
					time: new Date(),
					device: lock.id,
					type: "sent",
					created: item.created,
					payload: item.data,
					port: item.port,
					confirmed: item.confirmed
				});
				return false; // remove item
			});
		}

		let port = payload.port;
		let data = payload.payload_raw;
		if (port == 1 && data[0] == 0x01) {
			lock.state = data[1] === 0x01 ? "locked" : "open";
		}
		if (port == 10 && data[0] == 0x02) {
			lock.location = lock.location || {};
			lock.location.gps = {};

			lock.location.gps.lat =
				((data[1] << 16) >>> 0) + ((data[2] << 8) >>> 0) + data[3];
			lock.location.gps.lat =
				(lock.location.gps.lat / 16777215.0) * 180 - 90;

			lock.location.gps.lng =
				((data[4] << 16) >>> 0) + ((data[5] << 8) >>> 0) + data[6];
			lock.location.gps.lng =
				(lock.location.gps.lng / 16777215.0) * 360 - 180;

			var altValue = ((data[7] << 8) >>> 0) + data[8];
			var sign = data[7] & (1 << 7);
			if (sign) {
				lock.location.gps.alt = 0xffff0000 | altValue;
			} else {
				lock.location.gps.alt = altValue;
			}

			lock.location.gps.hdop = data[9] / 10.0;
			lock.location.gps.sat = data[10];
			lock.location.gps.valid = (lock.location.gps.lat != -90 && lock.location.gps.lat != -180 && lock.location.gps.alt != 0);
		}
		if (port == 11 && data[0] == 0x02) {
			lock.location = lock.location || {};
			lock.location.wifi = [];
			for (var i = 1; i <= data.length; i++) {
				try {
					let bssid =
						toHex(data[i]) +
						":" +
						toHex(data[++i]) +
						":" +
						toHex(data[++i]) +
						":" +
						toHex(data[++i]) +
						":" +
						toHex(data[++i]) +
						":" +
						toHex(data[++i]);
					let rssi = data[++i] * -1;
					lock.location.wifi.push({ bssid: bssid, rssi: rssi });
				} catch (e) {}
			}
			// remove old key
			if (lock.location.wifi_mls) {
				delete lock.location.wifi_mls;
			}
			if (lock.location.wifi.length > 0) {
				let mlsdata = {
					wifiAccessPoints: lock.location.wifi.map(wifi => ({
						macAddress: wifi.bssid,
						signalStrength: wifi.rssi
					}))
				};
				mozlocation.geolocate(mlsdata, function(err, loc) {
					lock.location.mls = loc;
				});
			}
		}
		lock.last_seen = payload.metadata.time;
	});
})();

app.get("/", (req, res) => {
	res.render("index", { locks: locks, log: log.slice(-50) });
});

app.get("/dump", (req, res) => {
	dumpLocks();
	res.redirect("back");
});

app.get("/state", (req, res) => {
	res.sendFile(STATE_PATH);
});

app.post("/lock/:id/unlock", (req, res) => {
	var lock = locks.find(l => l.id === req.params.id);
	if (typeof lock === "undefined") {
		res.status(404).send("Sorry, we cannot find that lock!");
		return;
	}

	if (typeof lockQueue[lock.id] === "undefined") {
		lockQueue[lock.id] = [];
	}

	let data = Buffer.from([0x01, 0x01, 0x01]);
	let timeout = +(new Date()) + 60 * 1000;

	lockQueue[lock.id].push({
		created: +(new Date()),
		timeout: timeout,
		data: data,
		port: 1,
		confirmed: false
	})

	log.push({
		time: new Date(),
		device: lock.id,
		type: "queued",
		timeout: timeout,
		payload: data
	});

	res.redirect("back");
});

setInterval(() => {
	for (let lockId in lockQueue) {
		if (lockQueue[lockId].length <= 0) {
			continue;
		}

		lockQueue[lockId] = lockQueue[lockId].filter((item) => {
			if (+(new Date()) > item.timeout) {
				log.push({
					time: new Date(),
					device: lockId,
					type: "timeout",
					created: item.created,
					timeout: item.timeout,
					payload: item.data,
					port: item.port,
					confirmed: item.confirmed
				});
			    return false; // remove item
			}
			return true;
		});
	}
}, 5000);

const server = app.listen(PORT, () =>
	console.log(`lockhandler running on ${JSON.stringify(server.address())}`)
);
