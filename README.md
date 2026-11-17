# GitHub-compatible git forge — make.fun bounty `github-core-clone-01`

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Wiliyantoro/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Wiliyantoro/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge written by hand in TypeScript (Node 22, standard library only, no network inside the trial pod). Serves git smart HTTP (upload-pack v2, receive-pack v0), the GitHub REST v3 API, GraphQL v4, and the Model Context Protocol. Built for make.fun's "Build a GitHub-compatible git forge" bounty ($500 USDC pool).

## Run locally

```sh
# Against the kit's local env:
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The entry binds an ephemeral port (`listen(0)`), registers it with the env, then polls `/done` until the trial finishes. The server in `app.ts` implements the scored surfaces; `main.ts` (from the kit) is the untouched entry↔env lifecycle.
