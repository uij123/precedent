.PHONY: run test infra gen reset

run:            ## start the app (UI :7400, payer sim :7402)
	npm start

test:           ## the harnesses — shown to judges
	node --test --test-reporter=spec

infra:          ## real sponsor backends: FalkorDB + LaserData stack
	-docker start falkordb 2>/dev/null || docker run -d --name falkordb -p 6379:6379 falkordb/falkordb:latest
	@test -d laser-stack || git clone https://github.com/laserdata/laser-stack
	cd laser-stack && ./scripts/up

gen:            ## regenerate consult scripts from the template
	node scripts/gen-consults.js

reset:          ## wipe the memory graph on a running app
	curl -s -X POST localhost:7400/api/reset && echo
