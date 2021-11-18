'use strict';

/* eslint-disable no-underscore-dangle */

const chai = require('chai');
const { assert } = chai;
const mockery = require('mockery');
const sinon = require('sinon');
const testConnection = require('../data/testConnection.json');

sinon.assert.expose(chai.assert, { prefix: '' });

describe('queue test', () => {
    let Executor;
    let executor;
    let resqueMock;
    let queueMock;
    let redisMock;
    let redisConstructorMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        queueMock = {
            connect: sinon.stub().resolves(),
            enqueue: sinon.stub().resolves(),
            enqueueAt: sinon.stub().resolves(),
            del: sinon.stub().resolves(1),
            delDelayed: sinon.stub().resolves(1),
            connection: {
                connected: false
            },
            end: sinon.stub().resolves()
        };
        resqueMock = {
            Queue: sinon.stub().returns(queueMock)
        };
        redisMock = {
            hdel: sinon.stub().yieldsAsync(),
            hset: sinon.stub().yieldsAsync(),
            set: sinon.stub().yieldsAsync(),
            expire: sinon.stub().yieldsAsync(),
            hget: sinon.stub().yieldsAsync()
        };
        redisConstructorMock = sinon.stub().returns(redisMock);

        mockery.registerMock('node-resque', resqueMock);
        mockery.registerMock('ioredis', redisConstructorMock);

        /* eslint-disable global-require */
        Executor = require('../../lib/queue');
        /* eslint-enable global-require */

        executor = new Executor({
            redisConnection: testConnection,
            breaker: {
                retry: {
                    retries: 1
                }
            }
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('construction', () => {
        it('constructs the executor', () => {
            assert.instanceOf(executor, Executor);
        });

        it('constructs the executor when no breaker config is passed in', () => {
            executor = new Executor({
                redisConnection: testConnection
            });

            assert.instanceOf(executor, Executor);
        });

        it('takes in a prefix', () => {
            executor = new Executor({
                redisConnection: testConnection,
                prefix: 'beta_'
            });

            assert.instanceOf(executor, Executor);
            assert.strictEqual(executor.prefix, 'beta_');
            assert.strictEqual(executor.buildQueue, 'beta_builds');
            assert.strictEqual(executor.buildConfigTable, 'beta_buildConfigs');
            assert.strictEqual(executor.timeoutQueue, 'beta_timeoutConfigs');
            assert.strictEqual(executor.cacheQueue, 'beta_cache');
            assert.strictEqual(executor.unzipQueue, 'beta_unzip');
            assert.strictEqual(executor.webhookTable, 'beta_webhooks');
        });

        it('throws when not given a redis connection', () => {
            assert.throws(() => new Executor(), 'No redis connection passed in');
        });
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(executor.stats(), {
                requests: {
                    total: 0,
                    timeouts: 0,
                    success: 0,
                    failure: 0,
                    concurrent: 0,
                    averageTime: 0
                },
                breaker: {
                    isClosed: true
                }
            });
        });
    });
});
