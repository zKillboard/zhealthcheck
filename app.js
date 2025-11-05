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
		isPrimary: false,
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
		const isPrimary = res.data?.isMongoPrimary === true;
		
		console.log(`${isHealthy ? '✅' : '❌'} ${server} is ${isHealthy ? 'online' : 'offline'}${isPrimary ? ' (PRIMARY - excluded from rotation)' : ''}`);
		
		return { isHealthy, isPrimary };
	} catch (e) {
		console.error('❌', server, e.response?.status || 'Connection failed');
		return { isHealthy: false, isPrimary: false };
	}
};

// DNS management functions now use the CloudflareAPI class
const getAllDNSRecords = () => cf.getAllRecords();
const createDNSRecord = (ip, serverName) => cf.createRecord(ip, serverName);
const deleteDNSRecord = (recordId, ip, serverName) => cf.deleteRecord(recordId, ip, serverName);

const updateServerHealth = (server, healthResult) => {
	const now = Date.now();
	const health = serverHealth[server.ip];
	const { isHealthy, isPrimary } = healthResult;
	
	// Update primary status
	health.isPrimary = isPrimary;
	
	if (isHealthy && !health.isHealthy) {
		health.lastHealthyTime = now;
		health.isHealthy = true;
		console.log(`📈 ${server.name} became healthy`);
	} else if (!isHealthy && health.isHealthy) {
		health.lastUnhealthyTime = now;
		health.isHealthy = false;
		console.log(`📉 ${server.name} became unhealthy`);
	}
};

const shouldAssignIP = (server) => {
	const health = serverHealth[server.ip];
	
	// Don't assign if not healthy or already assigned
	if (!health.isHealthy || health.isAssigned) return false;
	
	// If this is a primary server, only assign if it's the only healthy server available
	if (health.isPrimary) {
		const healthyNonPrimaryCount = Object.values(serverHealth).filter(h => 
			h.isHealthy && !h.isPrimary
		).length;
		
		if (healthyNonPrimaryCount > 0) {
			// Other healthy servers available, don't use primary
			return false;
		} else {
			// Primary is the only healthy server - use it as fallback
			console.log(`⚠️ Using primary server ${server.name} as only healthy option`);
			return true;
		}
	}
	
	// Non-primary healthy server - always assign
	return true;
};

const shouldUnassignIP = (server, assignedCount) => {
	const health = serverHealth[server.ip];
	
	// Don't unassign if not assigned or if healthy
	if (!health.isAssigned || health.isHealthy) return false;
	
	// If server became primary and is healthy, check if we have other healthy servers
	if (health.isPrimary && health.isHealthy) {
		const healthyNonPrimaryCount = Object.values(serverHealth).filter(h => 
			h.isHealthy && !h.isPrimary
		).length;
		
		if (healthyNonPrimaryCount > 0) {
			console.log(`🔄 Unassigning ${server.name} - became primary server`);
			return true;
		} else {
			console.log(`⚠️ Keeping primary server ${server.name} - no other healthy servers available`);
			return false;
		}
	}
	
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
	
	// Sort server names for consistent display
	const assignedServerNames = Array.from(currentIPs)
		.map(ip => serverMap[ip])
		.filter(name => name) // Remove any undefined names
		.sort();
	
	console.log(`🔍 Currently assigned: ${assignedServerNames.join(', ')}`);
	
	const assignedCount = currentIPs.size;
	const actions = [];
	
	// Determine actions needed (process servers in sorted order)
	const sortedServers = [...servers].sort((a, b) => a.name.localeCompare(b.name));
	for (const server of sortedServers) {
		const health = serverHealth[server.ip];
		
		if (shouldAssignIP(server)) {
			actions.push({ type: 'assign', server });
		} else if (shouldUnassignIP(server, assignedCount)) {
			const record = currentRecords.find(r => r.content === server.ip);
			if (record) actions.push({ type: 'unassign', server, recordId: record.id });
		}
		
		// Special case: if a currently assigned server became primary, check if we should unassign it
		if (health.isAssigned && health.isPrimary && health.isHealthy) {
			const healthyNonPrimaryCount = Object.values(serverHealth).filter(h => 
				h.isHealthy && !h.isPrimary
			).length;
			
			// Only remove primary if there are other healthy servers available
			if (healthyNonPrimaryCount > 0) {
				const record = currentRecords.find(r => r.content === server.ip);
				if (record && !actions.find(a => a.type === 'unassign' && a.server.ip === server.ip)) {
					console.log(`🔄 Removing primary server ${server.name} from rotation`);
					actions.push({ type: 'unassign', server, recordId: record.id });
				}
			} else {
				console.log(`⚠️ Keeping primary server ${server.name} - no alternatives available`);
			}
		}
	}
	
	// Sort actions to add records first, then remove (ensures at least one A record exists)
	const sortedActions = actions.sort((a, b) => {
		if (a.type === 'assign' && b.type === 'unassign') return -1;
		if (a.type === 'unassign' && b.type === 'assign') return 1;
		return 0;
	});

	// Execute actions
	for (const action of sortedActions) {
		try {
			if (action.type === 'assign') {
				await createDNSRecord(action.server.ip, action.server.name);
				serverHealth[action.server.ip].isAssigned = true;
			} else {
				await deleteDNSRecord(action.recordId, action.server.ip, action.server.name);
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

		// Check health of all servers (sorted by name for consistent ordering)
		const sortedServers = [...servers].sort((a, b) => a.name.localeCompare(b.name));
		const results = await Promise.all(
			sortedServers.map(async (s) => ({
				...s,
				healthResult: await checkHealth(s.name, s.ip),
			}))
		);

		console.log();

		// Update server health states
		for (const result of results) {
			updateServerHealth(result, result.healthResult);
		}

		console.log();

		// Manage DNS records based on health states
		await manageDNSRecords();

		console.log();
		
		// Display current status
		const healthyCount = results.filter(r => r.healthResult.isHealthy).length;
		const primaryCount = results.filter(r => r.healthResult.isPrimary).length;
		const assignedCount = Object.values(serverHealth).filter(h => h.isAssigned).length;
		
		console.log(`📊 Status: ${healthyCount}/${servers.length} healthy, ${primaryCount} primary, ${assignedCount} IP(s) assigned`);
		
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