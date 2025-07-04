# zhealthcheck

Used to check multiple IP addresses using a common domain name to determine if any of the servers are unhealthy.  If an unhealthy server is found it will update the give Cloudflare's DNS record to point to a healthy IP address. Note: This code will not throw an error if an https server is self signed.

## env variables

| Variable             | Note                                                                                                                  |
|----------------------|-----------------------------------------------------------------------------------------------------------------------|
| `CF_ACCOUNT_ID`      |                                                                                                                       |
| `CF_API_TOKEN`       |                                                                                                                       |
| `CF_RECORD_ID`       |                                                                                                                       |
| `CF_RECORD_NAME`     | Should be the same as `spoof_host` below.                                                                             |
| `CF_ZONE_ID`         |                                                                                                                       |
| `servers`            | A JSON-parsable string that indicates the names of servers and their IP addresses. Can be any length. Recommend at least 3. Example: `[{"name":"name of server 1","ip":"1.2.3.4"},{"name":"name of server 2","ip":"2.3.4.5"},{"name":"name of server 3","ip":"3.4.5.6"}]`|
| `spoof_host`         | The domain of the site you are checking, e.g. `https://example.com`. Should be the same as `CF_RECORD_NAME`.          |
| `health_check_url`   | A URL of a health script if you have one, or just `https://example.com/` if you're fine with checking root.           |
| `interval_seconds`   | Optional. If present, the script will not stop after first execution and will execute every `interval_seconds` seconds. |

## execution

Either will work:
- `node app.js`
- `npm start`

## example

![image](https://github.com/user-attachments/assets/ed0ffa4b-3643-4995-a5e7-f6fb28e50130)
