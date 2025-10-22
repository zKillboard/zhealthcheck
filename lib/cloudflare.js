const axios = require('axios');

class CloudflareAPI {
	constructor(config) {
		this.apiToken = config.apiToken;
		this.zoneId = config.zoneId;
		this.recordName = config.recordName;
		this.lastRequest = 0;
		this.minInterval = 1000;
		this.retryDelays = [1000, 2000, 4000, 8000];
	}

	async makeRequest(requestFn, operation = 'API request') {
		const maxRetries = this.retryDelays.length;
		
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				// Rate limiting
				const now = Date.now();
				const timeSinceLastRequest = now - this.lastRequest;
				if (timeSinceLastRequest < this.minInterval) {
					await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLastRequest));
				}
				
				this.lastRequest = Date.now();
				const result = await requestFn();
				
				if (attempt > 0) {
					console.log(`✅ ${operation} succeeded after ${attempt} retries`);
				}
				
				return result;
			} catch (error) {
				const isLastAttempt = attempt === maxRetries;
				const isRateLimit = error.response?.status === 429 || error.response?.data?.errors?.[0]?.code === 10013;
				const isRetryable = isRateLimit || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' ||
								   (error.response?.status >= 500 && error.response?.status < 600);
				
				if (isLastAttempt || !isRetryable) {
					console.error(`❌ ${operation} failed:`, error.response?.data || error.message);
					throw error;
				}
				
				const delay = this.retryDelays[attempt];
				console.warn(`⚠️ ${operation} failed, retrying in ${delay}ms...`);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
	}

	async getAllRecords() {
		return await this.makeRequest(async () => {
			const res = await axios.get(
				`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(this.zoneId)}/dns_records`,
				{
					headers: { Authorization: `Bearer ${this.apiToken}` },
					params: { name: this.recordName, type: 'A' },
					timeout: 10000
				}
			);
			return res.data.result;
		}, 'Get DNS records');
	}

	async createRecord(ip, serverName = null) {
		const { isValidIP } = require('./config');
		if (!isValidIP(ip)) {
			throw new Error(`Invalid IP address: ${ip}`);
		}

		await this.makeRequest(async () => {
			await axios.post(
				`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(this.zoneId)}/dns_records`,
				{
					type: "A",
					name: this.recordName,
					content: ip,
					ttl: 300,
					proxied: true,
				},
				{ 
					headers: { Authorization: `Bearer ${this.apiToken}` },
					timeout: 10000
				}
			);
		}, `Create DNS record for ${serverName || 'server'}`);
		
		console.log(`✅ Added DNS record for ${serverName || 'server'}`);
	}

	async deleteRecord(recordId, ip, serverName = null) {
		if (!/^[a-f0-9]{32}$/.test(recordId)) {
			throw new Error(`Invalid record ID: ${recordId}`);
		}

		await this.makeRequest(async () => {
			await axios.delete(
				`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(this.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
				{ 
					headers: { Authorization: `Bearer ${this.apiToken}` },
					timeout: 10000
				}
			);
		}, `Delete DNS record for ${serverName || 'server'}`);
		
		console.log(`🗑️ Removed DNS record for ${serverName || 'server'}`);
	}
}

module.exports = CloudflareAPI;