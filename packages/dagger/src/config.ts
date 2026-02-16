/**
 * Inline plattr.yaml parser — the Dagger engine can't import js-yaml or
 * @plattr/shared, so we parse the well-known YAML format with simple string logic.
 */

export interface PlattrConfig {
  name: string
  framework?: string
  database?: { enabled: boolean; schemaName?: string }
  storage?: { enabled: boolean; buckets: Array<{ name: string; public: boolean }> }
  auth?: { enabled: boolean }
  local?: { port?: number; env?: Record<string, string> }
}

export function parseConfig(yaml: string): PlattrConfig {
  const lines = yaml.split("\n")
  const config: PlattrConfig = { name: "" }

  let section = ""
  let inBuckets = false
  let currentBucket: { name: string; public: boolean } | null = null

  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (!trimmed || trimmed.trim().startsWith("#")) continue

    const indent = trimmed.length - trimmed.trimStart().length
    const content = trimmed.trim()

    if (indent === 0 && content.includes(":")) {
      // Flush any pending bucket
      if (currentBucket && config.storage) {
        config.storage.buckets.push(currentBucket)
        currentBucket = null
      }
      inBuckets = false

      const colonIdx = content.indexOf(":")
      const key = content.substring(0, colonIdx).trim()
      const value = content.substring(colonIdx + 1).trim()
      section = key

      if (key === "name" && value) config.name = value
      if (key === "framework" && value) config.framework = value
    } else if (indent === 2 && content.includes(":")) {
      const colonIdx = content.indexOf(":")
      const key = content.substring(0, colonIdx).trim()
      const value = content.substring(colonIdx + 1).trim()

      if (section === "database") {
        if (!config.database) config.database = { enabled: false }
        if (key === "enabled") config.database.enabled = value === "true"
        else if (key === "schemaName") config.database.schemaName = value
      } else if (section === "storage") {
        if (!config.storage) config.storage = { enabled: false, buckets: [] }
        if (key === "enabled") config.storage.enabled = value === "true"
        if (key === "buckets") inBuckets = true
      } else if (section === "auth") {
        if (!config.auth) config.auth = { enabled: false }
        if (key === "enabled") config.auth.enabled = value === "true"
      } else if (section === "local") {
        if (!config.local) config.local = {}
        if (key === "port") config.local.port = parseInt(value, 10)
      }
    } else if (indent >= 4 && inBuckets) {
      if (content.startsWith("- name:")) {
        // Flush previous bucket
        if (currentBucket && config.storage) {
          config.storage.buckets.push(currentBucket)
        }
        currentBucket = { name: content.replace("- name:", "").trim(), public: false }
      } else if (content.startsWith("public:") && currentBucket) {
        currentBucket.public = content.replace("public:", "").trim() === "true"
      }
    }
  }

  // Flush last bucket
  if (currentBucket && config.storage) {
    config.storage.buckets.push(currentBucket)
  }

  // Default schemaName from app name
  if (config.database && !config.database.schemaName) {
    config.database.schemaName = config.name.replace(/-/g, "_")
  }

  return config
}
