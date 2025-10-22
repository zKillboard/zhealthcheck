# zhealthcheck

Used to check multiple IP addresses using a common domain name and dynamically assign/unassign IPs to the root domain based on server health. Healthy servers get their IPs assigned to provide load balancing, while unhealthy servers get their IPs removed after a grace period to prevent flapping. Ensures a minimum of 1 IP remains assigned at all times. Note: This code will not throw an error if an https server is self signed.

## Features

- **Dynamic IP Assignment**: Automatically assigns IPs of healthy servers to the domain
- **Load Balancing**: All healthy servers are assigned simultaneously 
- **Grace Period**: 30 second grace period before unassigning unhealthy servers
- **Minimum Assignment**: Always keeps at least 1 IP assigned to prevent complete outage
~~- **Flap Prevention**: Prevents rapid assignment/unassignment cycles~~ (not true with a 30 second grace period)

## env variables

| Variable             | Note                                                                                                                  |
|----------------------|-----------------------------------------------------------------------------------------------------------------------|
| `CF_ACCOUNT_ID`      |                                                                                                                       |
| `CF_API_TOKEN`       |                                                                                                                       |
| `CF_RECORD_ID`       | **No longer used** - the system now manages multiple A records dynamically                                            |
| `CF_RECORD_NAME`     | The domain name for which A records will be managed (e.g., `example.com`)                                             |
| `CF_ZONE_ID`         | Cloudflare Zone ID for the domain                                                                                     |
| `servers`            | A JSON-parsable string that indicates the names of servers and their IP addresses. Each healthy server will have its IP assigned to the domain. Example: `[{"name":"name of server 1","ip":"1.2.3.4"},{"name":"name of server 2","ip":"2.3.4.5"},{"name":"name of server 3","ip":"3.4.5.6"}]`|
| `spoof_host`         | The domain of the site you are checking, e.g. `zkillboard.com`. Should match `CF_RECORD_NAME`.                        |
| `health_check_url`   | A URL of a health script if you have one, or just the root domain if you're checking basic connectivity.               |
| `interval_seconds`   | Optional. If present, the script will not stop after first execution and will execute every `interval_seconds` seconds. |

## execution

Either will work:
- `node app.js`
- `npm start`

### IMPORTANT

node v18 required! versions 19+ seem to have issues with DNS override lookups that have not been addressed yet...

## example

<img width="1146" height="346" alt="image" src="https://github.com/user-attachments/assets/ab6572fc-d059-4988-8258-88a0315dc247" />

