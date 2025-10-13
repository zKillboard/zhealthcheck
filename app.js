const axios = require('axios');
const https = require('https');

require("dotenv").config();

// Input validation and parsing
let servers;
try {
	const serversData = JSON.parse(process.env.servers);
	if (!Array.isArray(serversData) || serversData.length === 0) {
		throw new Error('servers must be a non-empty array');
	}
	
	// Helper function for proper IP validation
	const isValidIP = (ip) => {
		const parts = ip.split('.');
		if (parts.length !== 4) return false;
		
		return parts.every(part => {
			// Check if part is a valid number string (no leading zeros except for "0")
			if (!/^(0|[1-9]\d*)$/.test(part)) return false;
			
			const num = parseInt(part, 10);
			return num >= 0 && num <= 255;
		});
	};

	// Validate server objects
	servers = serversData.map(s => {
		if (!s.name || !s.ip) {
			throw new Error('Each server must have name and ip properties');
		}
		// Proper IP validation with range checking
		if (!isValidIP(s.ip)) {
			throw new Error(`Invalid IP address: ${s.ip} (must be valid IPv4 with octets 0-255)`);
		}
		return s;
	});
} catch (e) {
	console.error('❌ Invalid servers configuration:', e.message);
	process.exit(1);
}

// Validate required environment variables
const requiredEnvVars = ['CF_API_TOKEN', 'CF_ZONE_ID', 'CF_RECORD_NAME', 'spoof_host', 'health_check_url'];
for (const envVar of requiredEnvVars) {
	if (!process.env[envVar]) {
		console.error(`❌ Missing required environment variable: ${envVar}`);
		process.exit(1);
	}
}

const serverMap = {};
servers.forEach((s) => { serverMap[s.ip] = s.name });

// State management for grace periods and health tracking
const serverHealth = {};
const GRACE_PERIOD_MS = 30 * 1000; // 30 seconds in milliseconds

// Rate limiting for Cloudflare API
const API_RATE_LIMIT = {
	lastRequest: 0,
	minInterval: 1000, // Minimum 1 second between API calls
	retryDelays: [1000, 2000, 4000, 8000], // Exponential backoff delays
};

// API wrapper with rate limiting and retry logic
const makeCloudflareRequest = async (requestFn, operation = 'API request') => {
	const maxRetries = API_RATE_LIMIT.retryDelays.length;
	
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			// Rate limiting - ensure minimum interval between requests
			const now = Date.now();
			const timeSinceLastRequest = now - API_RATE_LIMIT.lastRequest;
			if (timeSinceLastRequest < API_RATE_LIMIT.minInterval) {
				const waitTime = API_RATE_LIMIT.minInterval - timeSinceLastRequest;
				await new Promise(resolve => setTimeout(resolve, waitTime));
			}
			
			API_RATE_LIMIT.lastRequest = Date.now();
			const result = await requestFn();
			
			// Reset retry count on success
			if (attempt > 0) {
				console.log(`✅ ${operation} succeeded after ${attempt} retries`);
			}
			
			return result;
		} catch (error) {
			const isLastAttempt = attempt === maxRetries;
			
			// Check if it's a rate limit error
			const isRateLimit = error.response?.status === 429 || 
							  error.response?.data?.errors?.[0]?.code === 10013;
			
			// Check if it's a temporary error worth retrying
			const isRetryable = isRateLimit || 
							   error.code === 'ECONNRESET' || 
							   error.code === 'ETIMEDOUT' ||
							   (error.response?.status >= 500 && error.response?.status < 600);
			
			if (isLastAttempt || !isRetryable) {
				console.error(`❌ ${operation} failed after ${attempt} attempts:`, error.response?.data || error.message);
				throw error;
			}
			
			const delay = API_RATE_LIMIT.retryDelays[attempt];
			console.warn(`⚠️ ${operation} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}
};

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

		const isHealthy = res.status === 200;
		console.log(`${isHealthy ? '✅' : '❌'} ${server} is ${isHealthy ? 'online' : 'offline'}`);

		return isHealthy;
	} catch (e) {
		if (e.response) {
			console.error('❌', server, e.response.status, e.response.data);
		} else {
			console.error('💥', server, e.message);
		}
		return false;
	}
};

const getAllDNSRecords = async () => {
	return await makeCloudflareRequest(async () => {
		// Validate and encode URL parameters to prevent injection
		const zoneId = encodeURIComponent(process.env.CF_ZONE_ID);
		const recordName = encodeURIComponent(process.env.CF_RECORD_NAME);
		
		const res = await axios.get(
			`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
			{
				headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
				params: {
					name: recordName,
					type: 'A'
				},
				timeout: 10000 // 10 second timeout
			}
		);
		return res.data.result;
	}, 'Get DNS records');
};

const createDNSRecord = async (ip) => {
	// Helper function for proper IP validation (reused from startup validation)
	const isValidIP = (ip) => {
		const parts = ip.split('.');
		if (parts.length !== 4) return false;
		
		return parts.every(part => {
			if (!/^(0|[1-9]\d*)$/.test(part)) return false;
			const num = parseInt(part, 10);
			return num >= 0 && num <= 255;
		});
	};
	
	// Validate IP address format with proper range checking
	if (!isValidIP(ip)) {
		throw new Error(`Invalid IP address format: ${ip} (must be valid IPv4 with octets 0-255)`);
	}
	
	await makeCloudflareRequest(async () => {
		const zoneId = encodeURIComponent(process.env.CF_ZONE_ID);
		
		await axios.post(
			`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
			{
				type: "A",
				name: process.env.CF_RECORD_NAME,
				content: ip,
				ttl: 300,
				proxied: true,
			},
			{ 
				headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
				timeout: 10000
			}
		);
	}, `Create DNS record for ${ip}`);
	
	console.log(`✅ Added DNS record for ${ip}`);
};

const deleteDNSRecord = async (recordId, ip) => {
	// Validate record ID format (Cloudflare record IDs are 32-character hex strings)
	if (!/^[a-f0-9]{32}$/.test(recordId)) {
		throw new Error(`Invalid record ID format: ${recordId}`);
	}
	
	await makeCloudflareRequest(async () => {
		const zoneId = encodeURIComponent(process.env.CF_ZONE_ID);
		const encodedRecordId = encodeURIComponent(recordId);
		
		await axios.delete(
			`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${encodedRecordId}`,
			{ 
				headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
				timeout: 10000
			}
		);
	}, `Delete DNS record for ${ip}`);
	
	console.log(`🗑️ Removed DNS record for ${ip}`);
};

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

async function shouldAssignIP(server) {
	const health = serverHealth[server.ip];
	return health.isHealthy && !health.isAssigned;
}

async function shouldUnassignIP(server, assignedCount) {
	const health = serverHealth[server.ip];
	
	if (!health.isAssigned || health.isHealthy) {
		return false;
	}
	
	// Don't unassign if it would leave us with less than minimum required
	if (assignedCount <= 1) {
		console.log(`⚠️ Cannot unassign ${server.name} - would leave less than minimum (1) IP assigned`);
		return false;
	}
	
	// Check if grace period has passed
	const timeSinceUnhealthy = Date.now() - health.lastUnhealthyTime;
	if (timeSinceUnhealthy < GRACE_PERIOD_MS) {
		const remainingTime = Math.ceil((GRACE_PERIOD_MS - timeSinceUnhealthy) / 1000);
		console.log(`⏳ ${server.name} grace period: ${remainingTime}s remaining`);
		return false;
	}
	
	return true;
}

async function manageDNSRecords() {
	let currentRecords;
	try {
		currentRecords = await getAllDNSRecords();
	} catch (error) {
		console.error('❌ Failed to fetch current DNS records, skipping DNS management this cycle');
		return;
	}
	
	const currentIPs = new Set(currentRecords.map(r => r.content));
	
	// Update assignment status based on current DNS records
	servers.forEach(server => {
		serverHealth[server.ip].isAssigned = currentIPs.has(server.ip);
	});
	
	console.log(`🔍 Currently assigned IPs: ${Array.from(currentIPs).map(ip => `${serverMap[ip]}(${ip})`).join(', ')}`);
	
	const assignedCount = currentIPs.size;
	const actions = [];
	
	// Check for IPs to assign (healthy servers not currently assigned)
	for (const server of servers) {
		if (await shouldAssignIP(server)) {
			actions.push({ type: 'assign', server });
		}
	}
	
	// Check for IPs to unassign (unhealthy servers past grace period)
	for (const server of servers) {
		if (await shouldUnassignIP(server, assignedCount)) {
			const record = currentRecords.find(r => r.content === server.ip);
			if (record) {
				actions.push({ type: 'unassign', server, recordId: record.id });
			}
		}
	}
	
	// Execute actions with individual error handling
	for (const action of actions) {
		try {
			if (action.type === 'assign') {
				await createDNSRecord(action.server.ip);
				serverHealth[action.server.ip].isAssigned = true;
			} else if (action.type === 'unassign') {
				await deleteDNSRecord(action.recordId, action.server.ip);
				serverHealth[action.server.ip].isAssigned = false;
			}
		} catch (error) {
			console.error(`❌ Failed to ${action.type} IP ${action.server.ip} for ${action.server.name}: ${error.message}`);
			// Continue with other actions even if one fails
		}
	}
	
	if (actions.length === 0) {
		console.log(`✅ No DNS changes needed`);
	}
}

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
		if (process.env.interval_seconds) {
			console.log(`⏰ Next check in ${process.env.interval_seconds} seconds...`);
			setTimeout(doCheckups, process.env.interval_seconds * 1000);
		}
	}
}

doCheckups();