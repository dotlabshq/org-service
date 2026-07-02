image := "ghcr.io/dotlabshq/org-service"

generate:
    npx drizzle-kit generate

migrate db="clave-db":
    flect db migrate {{db}} --dir ./migrations

build tag="latest":
    docker build --platform linux/amd64 -t {{image}}:{{tag}} .

push tag="latest":
    docker push {{image}}:{{tag}}

release tag:
    just build {{tag}}
    just push {{tag}}

run tag="latest":
    docker run --rm -p 3000:3000 --env-file .env {{image}}:{{tag}}
