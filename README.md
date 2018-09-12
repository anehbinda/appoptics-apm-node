# AppOptics APM

The `appoptics-apm` module provides [AppOptics](https://www.appoptics.com/) instrumentation for Node.js.

It has the ability to report performance metrics on an array of libraries,
databases and frameworks.

It requires an [AppOptics](https://www.appoptics.com/) account to
view metrics.  Get yours; [it's free](https://my.appoptics.com/sign_up).

## Dependencies

- Linux
- Node.js v6+ [Maintenance and Active LTS](https://github.com/nodejs/Release)

The agent compiles a C++ addon during install, thus you’ll need to have the following on the system prior to installing the agent:

- gcc version 4.7 and above
- for node-gyp: make and python 2.x (version 2.7 is [recommended](https://github.com/nodejs/node-gyp#on-unix))


## Installation

The `appoptics-apm` module is [available on npm](http://npmjs.org/package/appoptics-apm) and can be installed by navigating to your app root and running:

```
npm install --save appoptics-apm
```

The agent requires a service key, obtained from the AppOptics dashboard under "Organization Details", to connect to your account.  This is set via the `APPOPTICS_SERVICE_KEY` environment variable, make sure it is available in the environment where your application is running:

```
export APPOPTICS_SERVICE_KEY="api-token-here:your-service-name"
```

Then, at the top of your main js file for your app, add this:

```
require('appoptics-apm')
```

Now restart your app and you should see data in your AppOptics dashboard in a minute or two.

## Configuration

See the [Configuration Guide](https://github.com/appoptics/appoptics-apm-node/blob/master/guides/configuration.md)

## Upgrading

To upgrade an existing installation, navigate to your app root and run:

```
npm install --save appoptics-apm@latest
```

## Adding Your Own Spans

Our GitHub repository hosts an [overview](https://github.com/appoptics/appoptics-apm-node/blob/master/guides/instrumenting-a-module.md) and a [complete API reference](https://github.com/appoptics/appoptics-apm-node/blob/master/guides/api.md).

## Support

If you find a bug or would like to request an enhancement, feel free to file
an issue. For all other support requests, please email support@appoptics.com.

## Contributing

You are obviously a person of great sense and intelligence. We happily
appreciate all contributions to the oboe module whether it is documentation,
a bug fix, new instrumentation for a library or framework or anything else
we haven't thought of.

We welcome your PRs. We ask that any new
instrumentation submissions have corresponding tests that accompany
them. This way we won't break any of your additions when we (and others)
make subsequent changes.

## Developer Resources

We have made an effort to expose technical information to enable
developers to contribute to the appoptics module for any that may
wish to do so.
Below is a good source of information and help for developers:

* The [AppOptics Knowledge Base](https://docs.appoptics.com) has
a large collection of technical articles or, if needed, you can submit a
support request directly to the team.

If you have any questions or ideas, don't hesitate to contact us anytime.

## Layout of the module

The oboe module uses a standard layout.  Here are the notable directories.

```
lib/        # Span and Event constructors
lib/probes  # Auto loaded instrumentation
test/       # Mocha test suite
```

## Compiling the C extension

This module utilizes a C++ node extension to interface with the `liboboe.so`
library.  `liboboe` is installed as part of the `appoptics-bindings` package
which is a dependency of this package.  It is used to report host and
performance metrics to AppOptics servers.

If you would like to work with the C++ extension, clone the github
`appoptics-bindings-node` repository and work with that.

## License

Copyright (c) 2016, 2017, 2018 SolarWinds, LLC

Released under the [Librato Open License](https://docs.appoptics.com/kb/apm_tracing/librato-open-license/)
