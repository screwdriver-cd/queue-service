'use strict';

const { assert } = require('chai');
const LuaTestHelper = require('./luaTestHelper');

describe('CollapseDecider.lua (Lua Script Tests)', () => {
    let helper;

    beforeEach(async () => {
        helper = new LuaTestHelper();
        await helper.start(); // Start real Redis server
    });

    afterEach(async () => {
        await helper.cleanup();
    });

    describe('shouldCollapse', () => {
        it('should not collapse when collapse disabled', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'shouldCollapse', [
                100, // buildId
                [100, 101, 102], // waitingBuilds
                null, // lastRunningBuildId
                false // collapseEnabled
            ]);

            assert.isFalse(result.shouldCollapse);
            assert.equal(result.reason, 'COLLAPSE_DISABLED');
        });

        it('should not collapse when no waiting builds', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'shouldCollapse', [
                100,
                [],
                null,
                true
            ]);

            assert.isFalse(result.shouldCollapse);
            assert.equal(result.reason, 'NO_WAITING_BUILDS');
        });

        it('should collapse when older than last running build', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'shouldCollapse', [
                100, // current build
                [100, 101, 102], // waiting
                105, // lastRunningBuildId (newer)
                true
            ]);

            assert.isTrue(result.shouldCollapse);
            assert.equal(result.reason, 'OLDER_THAN_LAST_RUNNING');
            assert.equal(result.newestBuild, 102);
            assert.equal(result.lastRunningBuildId, 105);
        });

        it('should collapse when newer build exists in queue', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'shouldCollapse', [
                100, // current build
                [100, 101, 102, 103], // waiting (103 is newer)
                null,
                true
            ]);

            assert.isTrue(result.shouldCollapse);
            assert.equal(result.reason, 'NEWER_BUILD_EXISTS');
            assert.equal(result.newestBuild, 103);
        });

        it('should not collapse when current is newest', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'shouldCollapse', [
                103, // current build
                [100, 101, 102, 103], // waiting (current is newest)
                null,
                true
            ]);

            assert.isFalse(result.shouldCollapse);
            assert.equal(result.reason, 'IS_NEWEST_BUILD');
        });

        it('should not collapse when is newest in waiting queue', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'shouldCollapse', [
                111, // current build (newest)
                [110, 111], // waiting
                105, // lastRunningBuildId (older)
                true
            ]);

            // Current build is the newest in waiting queue
            assert.isFalse(result.shouldCollapse);
            assert.equal(result.reason, 'IS_NEWEST_BUILD');
        });
    });

    describe('getBuildsToCollapse', () => {
        it('should return all builds older than newest', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'getBuildsToCollapse', [
                [100, 101, 102, 103], // waitingBuilds
                103 // newestBuildId
            ]);

            // Should return string build IDs (as stored in Redis)
            assert.deepEqual(result, [100, 101, 102]);
        });

        it('should return empty array when only one build', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'getBuildsToCollapse', [
                [100],
                100
            ]);

            // Empty Lua table can encode as either [] or {} depending on cjson settings
            assert.isTrue(Array.isArray(result) || (typeof result === 'object' && Object.keys(result).length === 0));
        });

        it('should handle when newest is not in list', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'getBuildsToCollapse', [
                [100, 101, 102],
                105 // newest is higher than all in list
            ]);

            assert.deepEqual(result, [100, 101, 102]);
        });
    });

    describe('findNewestBuild', () => {
        it('should find newest build in list', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'findNewestBuild', [
                [100, 105, 102, 103] // unsorted
            ]);

            assert.equal(result, 105);
        });

        it('should return nil for empty list', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'findNewestBuild', [[]]);

            assert.isNull(result);
        });

        it('should handle single build', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'findNewestBuild', [[42]]);

            assert.equal(result, 42);
        });
    });

    describe('findOldestBuild', () => {
        it('should find oldest build in list', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'findOldestBuild', [
                [105, 100, 102, 103] // unsorted
            ]);

            assert.equal(result, 100);
        });

        it('should return nil for empty list', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'findOldestBuild', [[]]);

            assert.isNull(result);
        });

        it('should handle single build', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'findOldestBuild', [[42]]);

            assert.equal(result, 42);
        });
    });

    describe('isBuildWaiting', () => {
        it('should return true when build is in waiting queue', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'isBuildWaiting', [
                101,
                [100, 101, 102]
            ]);

            assert.isTrue(result);
        });

        it('should return false when build is not in waiting queue', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'isBuildWaiting', [
                999,
                [100, 101, 102]
            ]);

            assert.isFalse(result);
        });

        it('should return false for empty waiting queue', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'isBuildWaiting', [100, []]);

            assert.isFalse(result);
        });

        it('should handle string and number comparison', async () => {
            const result = await helper.executeModuleFunction('CollapseDecider.lua', 'isBuildWaiting', [
                '101', // string buildId
                [100, 101, 102] // number array
            ]);

            assert.isTrue(result);
        });
    });
});
