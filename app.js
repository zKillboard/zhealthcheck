const axios = require('axios');
const https = require('https');
const { validateAndParseConfig } = require('./lib/config');
const CloudflareAPI = require('./lib/cloudflare');

// Load and validate configuration
let config, servers, serverMap;
try {
	config = validateAndParseConfig();
	servers = config.servers;
	serverMap = {};
	servers.forEach((s) => { serverMap[s.ip] = s.name });
} catch (e) {
	console.error('❌', e.message);
	process.exit(1);
}

// Initialize Cloudflare API
const cf = new CloudflareAPI(config.cloudflare);

// State management for grace periods and health tracking
const serverHealth = {};
const GRACE_PERIOD_MS = 30 * 1000; // 30 seconds

// Initialize server health tracking
servers.forEach(s => {
	serverHealth[s.ip] = {
		isHealthy: false,
		lastHealthyTime: null,
		lastUnhealthyTime: null,
		isAssigned: false
	};
});

const checkHealth = async (server, ip) => {
	const agent = new https.Agent({
		rejectUnauthorized: false,
		servername: config.health.spoofHost,
		lookup: (hostname, options, callback) => callback(null, ip, 4),
	});

	try {
		const res = await axios.get(config.health.healthCheckUrl, {
			httpsAgent: agent,
			headers: {
				Host: config.health.spoofHost,
				'User-Agent': 'curl/8.0.1',
				Accept: '*/*',
			},
			timeout: 3000,
		});

		const isHealthy = res.status === 200;
		console.log(`${isHealthy ? '✅' : '❌'} ${server} is ${isHealthy ? 'online' : 'offline'}`);
		return isHealthy;
	} catch (e) {
		console.error('❌', server, e.response?.status || 'Connection failed');
		return false;
	}
};

// DNS management functions now use the CloudflareAPI class
const getAllDNSRecords = () => cf.getAllRecords();
const createDNSRecord = (ip) => cf.createRecord(ip);
const deleteDNSRecord = (recordId, ip) => cf.deleteRecord(recordId, ip);

async function updateServerHealth(server, isHealthy) {
	const now = Date.now();
	const health = serverHealth[server.ip];
	
	if (isHealthy && !health.isHealthy) {
		health.lastHealthyTime = now;
		health.isHealthy = true;
		console.log(`📈 ${server.name} became healthy`);
	} else if (!isHealthy && health.isHealthy) {
		health.lastUnhealthyTime = now;
		health.isHealthy = false;
		console.log(`📉 ${server.name} became unhealthy`);
	}
}

const shouldAssignIP = (server) => {
	const health = serverHealth[server.ip];
	return health.isHealthy && !health.isAssigned;
};

const shouldUnassignIP = (server, assignedCount) => {
	const health = serverHealth[server.ip];
	
	if (!health.isAssigned || health.isHealthy) return false;
	
	if (assignedCount <= 1) {
		console.log(`⚠️ Cannot unassign ${server.name} - would leave < 1 IP`);
		return false;
	}
	
	const timeSinceUnhealthy = Date.now() - health.lastUnhealthyTime;
	if (timeSinceUnhealthy < GRACE_PERIOD_MS) {
		const remainingTime = Math.ceil((GRACE_PERIOD_MS - timeSinceUnhealthy) / 1000);
		console.log(`⏳ ${server.name} grace period: ${remainingTime}s remaining`);
		return false;
	}
	
	return true;
};

const manageDNSRecords = async () => {
	let currentRecords;
	try {
		currentRecords = await getAllDNSRecords();
	} catch (error) {
		console.error('❌ Failed to fetch DNS records, skipping this cycle');
		return;
	}
	
	const currentIPs = new Set(currentRecords.map(r => r.content));
	
	// Update assignment status
	servers.forEach(server => {
		serverHealth[server.ip].isAssigned = currentIPs.has(server.ip);
	});
	
	console.log(`🔍 Currently assigned: ${Array.from(currentIPs).map(ip => `${serverMap[ip]}(${ip})`).join(', ')}`);
	
	const assignedCount = currentIPs.size;
	const actions = [];
	
	// Determine actions needed
	for (const server of servers) {
		if (shouldAssignIP(server)) {
			actions.push({ type: 'assign', server });
		} else if (shouldUnassignIP(server, assignedCount)) {
			const record = currentRecords.find(r => r.content === server.ip);
			if (record) actions.push({ type: 'unassign', server, recordId: record.id });
		}
	}
	
	// Execute actions
	for (const action of actions) {
		try {
			if (action.type === 'assign') {
				await createDNSRecord(action.server.ip);
				serverHealth[action.server.ip].isAssigned = true;
			} else {
				await deleteDNSRecord(action.recordId, action.server.ip);
				serverHealth[action.server.ip].isAssigned = false;
			}
		} catch (error) {
			console.error(`❌ Failed to ${action.type} ${action.server.name}: ${error.message}`);
		}
	}
	
	if (actions.length === 0) console.log(`✅ No DNS changes needed`);
};

async function doCheckups() {
	try {
		console.clear();
		console.log(`🩺 Health Check - ${new Date().toISOString()}`);
		console.log('='.repeat(60));

		// Check health of all servers
		const results = await Promise.all(
			servers.map(async (s) => ({
				...s,
				healthy: await checkHealth(s.name, s.ip),
			}))
		);

		console.log();

		// Update server health states
		for (const result of results) {
			await updateServerHealth(result, result.healthy);
		}

		console.log();

		// Manage DNS records based on health states
		await manageDNSRecords();

		console.log();
		
		// Display current status
		const healthyCount = results.filter(s => s.healthy).length;
		const assignedCount = Object.values(serverHealth).filter(h => h.isAssigned).length;
		
		console.log(`📊 Status: ${healthyCount}/${servers.length} healthy, ${assignedCount} IP(s) assigned`);
		
		if (healthyCount === 0) {
			console.error("❌ All servers are down!");
		}

	} catch (e) {
		console.error('💥 Error during checkup:', e.message);
	} finally {
		if (config.health.intervalSeconds) {
			console.log(`⏰ Next check in ${config.health.intervalSeconds} seconds...`);
			setTimeout(doCheckups, config.health.intervalSeconds * 1000);
		}
	}
}

doCheckups();