# system error

Definition:
Infrastructure, server, endpoint, or runtime failure prevented normal operation.

When to use:
- 500 error
- timeout
- server not responding
- failed to fetch
- API/endpoint outage

When not to use:
- Business logic behaves incorrectly without server failure
- User selected wrong data

Possible causes to check:
- Server logs
- API response status
- Timeout duration
- Network path between app and service
