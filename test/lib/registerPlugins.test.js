'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Register Plugins', () => {
    const resourcePlugins = [
        'worker',
        'queue',
        'status'
    ];
    const defaultPlugin = [
        'blipp'
    ];
    const pluginLength = resourcePlugins.length + defaultPlugin.length;
    const mocks = {};
    const config = {};
    let main;
    let serverMock;

    before(() => {
        mockery.enable({
            warnOnUnregistered: false,
            useCleanCache: true
        });
    });

    beforeEach(() => {
        serverMock = {
            register: sinon.stub(),
            on: sinon.stub()
        };
        resourcePlugins.forEach((plugin) => {
            mocks[plugin] = sinon.stub();
            mockery.registerMock(plugin, mocks[plugin]);
        });

        /* eslint-disable global-require */
        main = require('../../lib/registerPlugins');
        /* eslint-enable global-require */
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
        main = null;
    });

    after(() => {
        mockery.disable();
    });

    it('registered resource plugins', async () => {
        serverMock.register.callsArgWithAsync(1);

        await main(serverMock, config);

        assert.equal(serverMock.register.callCount, pluginLength);

        resourcePlugins.forEach((plugin) => {
            assert.calledWith(serverMock.register, {
                plugin: mocks[plugin],
                options: {
                    name: plugin
                },
                routes: {
                    prefix: '/v1'
                }
            });
        });
    });

    it('bubbles failures up', async () => {
        serverMock.register.callsArgWithAsync(1, new Error('failure loading'));
        try {
            await main(serverMock, config);
        } catch (err) {
            assert.equal(err.message, 'failure loading');
        }
    });

    it('registers data for plugin when specified in the config object', async () => {
        serverMock.register.callsArgAsync(1);

        await main(serverMock, {
            auth: {
                foo: 'bar'
            }
        });
        assert.equal(serverMock.register.callCount, pluginLength);

        assert.calledWith(serverMock.register, {
            plugin: mocks['../plugins/queue'],
            options: {
                foo: 'bar'
            },
            routes: {
                prefix: '/v1'
            }
        });
    });
});
