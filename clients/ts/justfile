# npm publish for this @baseworks/* client. `just publish` = test + build + pack +
# check + publish current version; `just publish-patch` bumps the patch first.
# Requires `npm login` (public scope).
#
# What is published is the tarball that was checked, not a fresh pack: pnpm
# rewrites workspace:* ranges when it packs, and check-pack refuses the tarball
# if any survived (2.1.0 went out with them, published with plain npm).
default:
    @just --list

build:
    pnpm build

test:
    pnpm exec vitest run
    pnpm exec tsc --noEmit -p .

# Build and pack into .pack/, then check the tarball consumers would get.
pack: test build
    rm -rf .pack && mkdir .pack
    pnpm pack --pack-destination .pack
    node scripts/check-pack.mjs .pack/*.tgz

publish: pack
    npm publish .pack/*.tgz --access public

publish-patch:
    npm version patch --no-git-tag-version
    just publish
