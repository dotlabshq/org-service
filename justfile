image := "ghcr.io/dotlabshq/org-service"

build:
    pnpm build

patch: build
    npm version patch --no-git-tag-version

build-docker tag="latest":
    docker build --platform linux/amd64 -t {{image}}:{{tag}} .

push-docker tag="latest":
    docker push {{image}}:{{tag}}

