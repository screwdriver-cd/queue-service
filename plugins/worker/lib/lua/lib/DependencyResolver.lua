--[[
    This module provides functions to resolve build dependencies
    and determine if a build is blocked by other builds.
]]

local DependencyResolver = {}

--[[
    Parse blockedBy value (could be array, single value, or nil)
    @param blockedBy - Array of job IDs or single job ID
    @return {blocked, dependencies}
]]
function DependencyResolver.parseBlockedBy(blockedBy)
    -- Check for nil or cjson.null (JavaScript null becomes cjson.null)
    if not blockedBy or blockedBy == cjson.null then
        return {blocked = false, dependencies = {}}
    end

    -- Handle array
    if type(blockedBy) == "table" then
        if #blockedBy == 0 then
            return {blocked = false, dependencies = {}}
        end
        return {blocked = true, dependencies = blockedBy}
    end

    -- Handle single value
    return {blocked = true, dependencies = {blockedBy}}
end

--[[
    Check if build is blocked by running dependencies
    @param dependencies - Array of job IDs that block this build
    @param runningBuilds - Array of currently running build IDs
    @return {blocked, blockedBy, reason}
]]
function DependencyResolver.isBlockedByDependencies(dependencies, runningBuilds)
    local blockedByBuilds = {}

    -- Check if any dependency is in running builds
    for _, dep in ipairs(dependencies) do
        for _, running in ipairs(runningBuilds) do
            -- Convert both to strings for comparison
            if tostring(dep) == tostring(running) then
                table.insert(blockedByBuilds, dep)
                break
            end
        end
    end

    local isBlocked = #blockedByBuilds > 0

    return {
        blocked = isBlocked,
        blockedBy = blockedByBuilds,
        reason = isBlocked and "BLOCKED_BY_DEPENDENCIES" or "NOT_BLOCKED"
    }
end

--[[
    Check if build is blocked by same job (another build of same job running)
    @param jobId - Current job ID
    @param runningBuildId - Currently running build ID for this job (or nil)
    @param buildId - Current build ID
    @param blockedBySelf - Whether blocking by same job is enabled
    @return {blocked, reason}
]]
function DependencyResolver.isBlockedBySameJob(jobId, runningBuildId, buildId, blockedBySelf)
    if not blockedBySelf then
        return {blocked = false, reason = "BLOCKED_BY_SELF_DISABLED"}
    end

    -- Check for nil or cjson.null (JavaScript null becomes cjson.null)
    if not runningBuildId or runningBuildId == cjson.null then
        return {blocked = false, reason = "NO_RUNNING_BUILD"}
    end

    -- Convert to numbers for comparison
    local runningId = tonumber(runningBuildId)
    local currentId = tonumber(buildId)

    if runningId == currentId then
        return {blocked = false, reason = "SAME_BUILD_RUNNING"}
    end

    return {
        blocked = true,
        reason = "BLOCKED_BY_SAME_JOB",
        runningBuildId = runningId
    }
end

--[[
    Build blocked message for logging/status
    @param blockedBy - Array of blocking build IDs
    @param reason - Reason for blocking
    @return string message
]]
function DependencyResolver.buildBlockedMessage(blockedBy, reason)
    -- Check for nil, cjson.null, or empty array
    if not blockedBy or blockedBy == cjson.null or #blockedBy == 0 then
        return "Build is blocked: " .. reason
    end

    local buildIds = table.concat(blockedBy, ", ")
    return "Build is blocked by: " .. buildIds .. " (" .. reason .. ")"
end

return DependencyResolver
