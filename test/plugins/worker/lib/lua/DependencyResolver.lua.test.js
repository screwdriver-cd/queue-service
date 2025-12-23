'use strict';

const { assert } = require('chai');
const LuaTestHelper = require('./luaTestHelper');

describe('DependencyResolver.lua (Lua Script Tests)', () => {
    let helper;

    beforeEach(async () => {
        helper = new LuaTestHelper();
        await helper.start(); // Start real Redis server
    });

    afterEach(async () => {
        await helper.cleanup();
    });

    describe('parseBlockedBy', () => {
        it('should return not blocked when blockedBy is null', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'parseBlockedBy', [null]);

            assert.isFalse(result.blocked);
            assert.isTrue(Array.isArray(result.dependencies) || Object.keys(result.dependencies).length === 0);
        });

        it('should return not blocked when blockedBy is empty array', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'parseBlockedBy', [[]]);

            assert.isFalse(result.blocked);
            assert.isTrue(Array.isArray(result.dependencies) || Object.keys(result.dependencies).length === 0);
        });

        it('should parse array of dependencies', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'parseBlockedBy', [
                [111, 222, 333]
            ]);

            assert.isTrue(result.blocked);
            assert.deepEqual(result.dependencies, [111, 222, 333]);
        });

        it('should parse single dependency', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'parseBlockedBy', [777]);

            assert.isTrue(result.blocked);
            assert.deepEqual(result.dependencies, [777]);
        });
    });

    describe('isBlockedByDependencies', () => {
        it('should return not blocked when no dependencies running', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedByDependencies', [
                [111, 222, 333], // dependencies
                [444, 555, 666] // running builds
            ]);

            assert.isFalse(result.blocked);
            assert.isTrue(Array.isArray(result.blockedBy) || Object.keys(result.blockedBy).length === 0);
            assert.equal(result.reason, 'NOT_BLOCKED');
        });

        it('should return blocked when one dependency is running', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedByDependencies', [
                [111, 222, 333],
                [222, 444, 555] // 222 is running
            ]);

            assert.isTrue(result.blocked);
            assert.deepEqual(result.blockedBy, [222]);
            assert.equal(result.reason, 'BLOCKED_BY_DEPENDENCIES');
        });

        it('should return all blocking dependencies when multiple running', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedByDependencies', [
                [111, 222, 333],
                [111, 222, 444] // 111 and 222 running
            ]);

            assert.isTrue(result.blocked);
            assert.deepEqual(result.blockedBy, [111, 222]);
            assert.equal(result.reason, 'BLOCKED_BY_DEPENDENCIES');
        });

        it('should handle empty dependencies array', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedByDependencies', [
                [],
                [111, 222]
            ]);

            assert.isFalse(result.blocked);
            assert.isTrue(Array.isArray(result.blockedBy) || Object.keys(result.blockedBy).length === 0);
        });

        it('should handle empty running builds array', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedByDependencies', [
                [111, 222],
                []
            ]);

            assert.isFalse(result.blocked);
            assert.isTrue(Array.isArray(result.blockedBy) || Object.keys(result.blockedBy).length === 0);
        });

        it('should handle string and number comparison', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedByDependencies', [
                ['111', '222'], // string dependencies
                [111, 222, 333] // number running builds
            ]);

            assert.isTrue(result.blocked);
            assert.deepEqual(result.blockedBy, ['111', '222']);
        });
    });

    describe('isBlockedBySameJob', () => {
        it('should return not blocked when blockedBySelf is disabled', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedBySameJob', [
                777, // jobId
                123, // runningBuildId
                456, // buildId
                false // blockedBySelf
            ]);

            assert.isFalse(result.blocked);
            assert.equal(result.reason, 'BLOCKED_BY_SELF_DISABLED');
        });

        it('should return not blocked when no running build', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedBySameJob', [
                777,
                null, // no running build
                456,
                true
            ]);

            assert.isFalse(result.blocked);
            assert.equal(result.reason, 'NO_RUNNING_BUILD');
        });

        it('should return not blocked when same build is running', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedBySameJob', [
                777,
                456, // runningBuildId
                456, // buildId (same)
                true
            ]);

            assert.isFalse(result.blocked);
            assert.equal(result.reason, 'SAME_BUILD_RUNNING');
        });

        it('should return blocked when different build of same job running', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedBySameJob', [
                777,
                123, // runningBuildId
                456, // buildId (different)
                true
            ]);

            assert.isTrue(result.blocked);
            assert.equal(result.reason, 'BLOCKED_BY_SAME_JOB');
            assert.equal(result.runningBuildId, 123);
        });

        it('should handle string buildId comparison', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'isBlockedBySameJob', [
                777,
                '123', // string runningBuildId
                '123', // string buildId
                true
            ]);

            assert.isFalse(result.blocked);
            assert.equal(result.reason, 'SAME_BUILD_RUNNING');
        });
    });

    describe('buildBlockedMessage', () => {
        it('should build message with no blocking builds', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'buildBlockedMessage', [
                [],
                'TEST_REASON'
            ]);

            assert.equal(result, 'Build is blocked: TEST_REASON');
        });

        it('should build message with single blocking build', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'buildBlockedMessage', [
                [123],
                'BLOCKED_BY_SAME_JOB'
            ]);

            assert.equal(result, 'Build is blocked by: 123 (BLOCKED_BY_SAME_JOB)');
        });

        it('should build message with multiple blocking builds', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'buildBlockedMessage', [
                [111, 222, 333],
                'BLOCKED_BY_DEPENDENCIES'
            ]);

            assert.equal(result, 'Build is blocked by: 111, 222, 333 (BLOCKED_BY_DEPENDENCIES)');
        });

        it('should handle null blockedBy array', async () => {
            const result = await helper.executeModuleFunction('DependencyResolver.lua', 'buildBlockedMessage', [
                null,
                'NO_DEPENDENCIES'
            ]);

            assert.equal(result, 'Build is blocked: NO_DEPENDENCIES');
        });
    });
});
