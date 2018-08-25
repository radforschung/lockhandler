try {
	require("dotenv").config();
} catch (e) {
	// dotenv is only installed and needed for dev
}

const ttn = require("ttn");
const express = require("express");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const STATE_PATH = process.env.STATE_PATH || "locks.json";
const TTN_APP_ID = process.env.TTN_APP_ID;
const TTN_ACCESS_KEY = process.env.TTN_ACCESS_KEY;

if (typeof TTN_APP_ID === "undefined" || typeof TTN_ACCESS_KEY === "undefined") {
	console.error("please set the env variables TTN_APP_ID and TTN_ACCESS_KEY");
	process.exit(1);
}

const app = express();
app.set("view engine", "ejs");

let locks;
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
				last_seen: null
			};
			locks.push(lock);
		}
		if (payload.payload_raw.length >= 2) {
			lock.state = payload.payload_raw[1] === 0x01 ? "locked" : "open";
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

	let data = Buffer.from([0x01, 0x01, 0x01]);
	client.send(lock.id, data, 1, false, "last");
	log.push({
		time: new Date(),
		device: lock.id,
		type: "sent",
		payload: data
	});

	res.redirect("back");
});

const server = app.listen(PORT, () =>
	console.log(`lockhandler running on ${JSON.stringify(server.address())}`)
);
