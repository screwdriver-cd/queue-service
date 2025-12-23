--[[
    This module determines whether a build should be collapsed
    (discarded in favor of a newer build of the same job).
]]

local CollapseDecider = {}

--[[
    Determine if a build should be collapsed
    @param buildId - Current build ID
    @param waitingBuilds - Array of waiting build IDs for this job
    @param lastRunningBuildId - Last build that ran for this job
    @param collapseEnabled - Whether collapse feature is enabled
    @return {shouldCollapse, reason, newestBuild, collapseTarget}
]]
function CollapseDecider.shouldCollapse(buildId, waitingBuilds, lastRunningBuildId, collapseEnabled)
    if not collapseEnabled then
        return {
            shouldCollapse = false,
            reason = "COLLAPSE_DISABLED"
        }
    end

    if not waitingBuilds or #waitingBuilds == 0 then
        return {
            shouldCollapse = false,
            reason = "NO_WAITING_BUILDS"
        }
    end

    -- Find oldest and newest waiting builds
    local oldestBuild = tonumber(waitingBuilds[1])
    local newestBuild = tonumber(waitingBuilds[#waitingBuilds])
    local currentBuild = tonumber(buildId)

    -- Check if current build is older than last running build
    -- Note: cjson.null is used for JSON null values (not Lua nil)
    if lastRunningBuildId and lastRunningBuildId ~= cjson.null then
        local lastRunning = tonumber(lastRunningBuildId)
        if lastRunning and currentBuild < lastRunning then
            return {
                shouldCollapse = true,
                reason = "OLDER_THAN_LAST_RUNNING",
                newestBuild = newestBuild,
                lastRunningBuildId = lastRunning
            }
        end
    end

    -- Check if current build is not the newest waiting build
    if newestBuild and currentBuild < newestBuild then
        return {
            shouldCollapse = true,
            reason = "NEWER_BUILD_EXISTS",
            newestBuild = newestBuild
        }
    end

    -- Current build is the newest
    return {
        shouldCollapse = false,
        reason = "IS_NEWEST_BUILD"
    }
end

--[[
    Get list of builds that should be collapsed
    @param waitingBuilds - Array of all waiting build IDs
    @param newestBuildId - The newest build ID (don't collapse this one)
    @return Array of build IDs to collapse
]]
function CollapseDecider.getBuildsToCollapse(waitingBuilds, newestBuildId)
    local toCollapse = {}
    local newest = tonumber(newestBuildId)

    for _, buildId in ipairs(waitingBuilds) do
        local bid = tonumber(buildId)
        if bid < newest then
            table.insert(toCollapse, buildId)
        end
    end

    -- Mark as array for cjson (even if empty)
    setmetatable(toCollapse, cjson.array_mt)

    return toCollapse
end

--[[
    Find newest build in a list
    @param buildIds - Array of build IDs
    @return Newest build ID (as number) or nil
]]
function CollapseDecider.findNewestBuild(buildIds)
    if not buildIds or #buildIds == 0 then
        return nil
    end

    local newest = tonumber(buildIds[1])

    for i = 2, #buildIds do
        local current = tonumber(buildIds[i])
        if current > newest then
            newest = current
        end
    end

    return newest
end

--[[
    Find oldest build in a list
    @param buildIds - Array of build IDs
    @return Oldest build ID (as number) or nil
]]
function CollapseDecider.findOldestBuild(buildIds)
    if not buildIds or #buildIds == 0 then
        return nil
    end

    local oldest = tonumber(buildIds[1])

    for i = 2, #buildIds do
        local current = tonumber(buildIds[i])
        if current < oldest then
            oldest = current
        end
    end

    return oldest
end

--[[
    Check if a build is in the waiting queue
    @param buildId - Build ID to check
    @param waitingBuilds - Array of waiting build IDs
    @return boolean
]]
function CollapseDecider.isBuildWaiting(buildId, waitingBuilds)
    if not waitingBuilds or #waitingBuilds == 0 then
        return false
    end

    local targetId = tostring(buildId)

    for _, waitingId in ipairs(waitingBuilds) do
        if tostring(waitingId) == targetId then
            return true
        end
    end

    return false
end

return CollapseDecider
