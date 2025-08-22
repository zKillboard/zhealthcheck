const axios = require('axios');
const https = require('https');

require("dotenv").config();

const servers = JSON.parse(process.env.servers);
const serverMap = {};
servers.forEach((s) => { serverMap[s.ip] = s.name });

const checkHealth = async (server, ip) => {
	const agent = new https.Agent({
		rejectUnauthorized: false,  // Allow self-signed cert
		servername: process.env.spoof_host, // SNI matches the host
		lookup: (hostname, options, callback) => {
			return callback(null, ip, 4); // Override DNS
		},
	});

	try {
		const res = await axios.get(process.env.health_check_url, {
			httpsAgent: agent,
			headers: {
				Host: process.env.spoof_host,
				'User-Agent': 'curl/8.0.1', // Mimic curl
				Accept: '*/*',              // Mimic curl
			},
			timeout: 3000,
		});

		console.log(`✅ ${server} is online and`, (res.data.isMongoPrimary == true ? 'is' : 'is not'), `primary`);

		return res.status === 200 && res.data.isMongoPrimary == true;
	} catch (e) {
		if (e.response) {
			console.error('❌', server, e.response.status, e.response.data);
		} else {
			console.error('💥', server, e.message);
		}
		return false;
	}
};

const getCurrentDNS = async () => {
	const res = await axios.get(
		`https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/dns_records/${process.env.CF_RECORD_ID}`,
		{ headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` } }
	);
	return res.data.result.content;
};

const updateDNS = async (ip) => {
	await axios.put(
		`https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/dns_records/${process.env.CF_RECORD_ID}`,
		{
			type: "A",
			name: process.env.CF_RECORD_NAME,
			content: ip,
			ttl: 300,
			proxied: true,
		},
		{ headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` } }
	);
	console.log(`✅ Updated Cloudflare DNS to ${ip}`);
};

async function doCheckups() {
	try {
		console.clear();

		const currentIP = await getCurrentDNS();
		const currentName = serverMap[currentIP];
		console.log(`🔍 Current Server: ${currentName} (${currentIP})`);
		console.log();

		const results = await Promise.all(
			servers.map(async (s) => ({
				...s,
				healthy: await checkHealth(s.name, s.ip),
			}))
		);

		const healthy = results.filter((s) => s.healthy);
		const current = results.find((s) => s.ip === currentIP);

		console.log();

		if (current?.healthy) {
			console.log(`✅ ${current.name} is healthy — no action taken.`);
		} else if (healthy.length) {
			console.warn(`⚠️ ${current?.name || "Current server"} is down. Switching...`);
			await updateDNS(healthy[0].ip);
		} else {
			console.error("❌ All servers are down — cannot update DNS.");
		}

	} catch (e) {
		console.log(e);
	} finally {
		if (process.env.interval_seconds) {
			console.log(`... checking again in ${process.env.interval_seconds} seconds`)
			setTimeout(doCheckups, process.env.interval_seconds * 1000);
		}

	}
}
doCheckups();