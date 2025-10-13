const isValidIP = (ip) => {
	const parts = ip.split('.');
	if (parts.length !== 4) return false;
	
	return parts.every(part => {
		if (!/^(0|[1-9]\d*)$/.test(part)) return false;
		const num = parseInt(part, 10);
		return num >= 0 && num <= 255;
	});
};

const validateAndParseConfig = () => {
	require("dotenv").config();

	// Validate required environment variables
	const requiredEnvVars = ['CF_API_TOKEN', 'CF_ZONE_ID', 'CF_RECORD_NAME', 'spoof_host', 'health_check_url'];
	for (const envVar of requiredEnvVars) {
		if (!process.env[envVar]) {
			throw new Error(`Missing required environment variable: ${envVar}`);
		}
	}

	// Parse and validate servers configuration
	let servers;
	try {
		const serversData = JSON.parse(process.env.servers);
		if (!Array.isArray(serversData) || serversData.length === 0) {
			throw new Error('servers must be a non-empty array');
		}
		
		servers = serversData.map(s => {
			if (!s.name || !s.ip) {
				throw new Error('Each server must have name and ip properties');
			}
			if (!isValidIP(s.ip)) {
				throw new Error(`Invalid IP address: ${s.ip} (must be valid IPv4 with octets 0-255)`);
			}
			return s;
		});
	} catch (e) {
		throw new Error(`Invalid servers configuration: ${e.message}`);
	}

	return {
		servers,
		cloudflare: {
			apiToken: process.env.CF_API_TOKEN,
			zoneId: process.env.CF_ZONE_ID,
			recordName: process.env.CF_RECORD_NAME,
		},
		health: {
			spoofHost: process.env.spoof_host,
			healthCheckUrl: process.env.health_check_url,
			intervalSeconds: parseInt(process.env.interval_seconds) || null,
		}
	};
};

module.exports = { validateAndParseConfig, isValidIP };