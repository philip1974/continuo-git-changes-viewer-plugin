# Jump Back Onload Request Scope

BDD coverage for v0.1.5 startup file-scope setup.

The plugin registers its panel/commands without blocking onload, but stores a
`scopeReady` promise so jump-back clicks can wait for `app.fs.requestScope`.

