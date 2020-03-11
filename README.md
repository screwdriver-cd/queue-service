# Screwdriver Queue Service API
[![Version][npm-image]][npm-url] [![Pulls][docker-pulls]][docker-url] [![Stars][docker-stars]][docker-url] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] [![Coverage][cov-image]][cov-url] [![Vulnerabilities][vul-image]][vul-url] ![License][license-image] [![Slack][slack-image]][slack-url][![Coverage Status](https://coveralls.io/repos/github/screwdriver-cd/queue-service/badge.svg?branch=master)](https://coveralls.io/github/screwdriver-cd/queue-service?branch=master)

## Table of Contents

- [Background](#background)
- [Installation and Usage](#installation-and-usage)
- [Configuration](#configuration)
- [Testing](#testing)
- [Contribute](#contribute)
- [License](#license)

## Background

Screwdriver Queue Service is created to decouple the build queueing mechanism from Screwdriver APIs. It is a REST service with the idea of being highly available and resilient.

## Installation and Usage
```
    npm install
    npm start
```

### Plugins

This API comes with 2 resources:

 - [executor](plugins/executor/README.md)
 - [worker](plugins/worker/README.md)

### Prerequisites
To use Screwdriver Queue Service, you will need the following prerequisites:

- Node v12.0.0 or higher
- [Redis][redis-cli]

## Contribute
To start contributing to Screwdriver, have a look at our guidelines, as well as pointers on where to start making changes, in our [contributing guide](http://docs.screwdriver.cd/about/contributing).

## License

Code licensed under the BSD 3-Clause license. See [LICENSE file](https://github.com/screwdriver-cd/screwdriver/blob/master/LICENSE) for terms.

[npm-image]: https://img.shields.io/npm/v/screwdriver-queue-service.svg
[npm-url]: https://npmjs.org/package/screwdriver-queue-service
[cov-image]: https://coveralls.io/repos/github/screwdriver-cd/screwdriver-queue-service/badge.svg?branch=master
[cov-url]: https://coveralls.io/github/screwdriver-cd/screwdriver-queue-service?branch=master
[vul-image]: https://snyk.io/test/github/screwdriver-cd/screwdriver-queue-service.git/badge.svg
[vul-url]: https://snyk.io/test/github/screwdriver-cd/screwdriver-queue-service.git
[docker-pulls]: https://img.shields.io/docker/pulls/screwdrivercd/screwdriver-queue-service.svg
[docker-stars]: https://img.shields.io/docker/stars/screwdrivercd/screwdriver-queue-service.svg
[docker-url]: https://hub.docker.com/r/screwdrivercd/screwdriver-queue-service/
[license-image]: https://img.shields.io/npm/l/screwdriver-queue-service.svg
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/screwdriver-queue-service.svg
[issues-url]: https://github.com/screwdriver-cd/screwdriver-queue-service/issues
[status-image]: https://cd.screwdriver.cd/pipelines/1/badge
[status-url]: https://cd.screwdriver.cd/pipelines/1
[daviddm-image]: https://david-dm.org/screwdriver-cd/screwdriver-queue-service.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/screwdriver-queue-service
[slack-image]: http://slack.screwdriver.cd/badge.svg
[slack-url]: http://slack.screwdriver.cd/
[docker-compose]: https://www.docker.com/products/docker-compose
[nomad]: https://www.hashicorp.com/products/nomad
[docker]: https://www.docker.com/products/docker
[kubectl]: https://kubernetes.io/docs/user-guide/kubectl-overview/
[redis-cli]: https://redis.io/