/**
 * @param {unknown} configItem
 * @returns {unknown}
 */
export function evalJSONConfig(configItem) {
  if (Array.isArray(configItem)) {
    return configItem.map((item) => evalJSONConfig(item));
  }

  if (typeof configItem === "object" && configItem !== null) {
    if (
      Object.keys(configItem).length === 1 &&
      "$regex" in configItem &&
      typeof configItem.$regex === "string"
    ) {
      return new RegExp(configItem.$regex);
    }

    if (
      Object.keys(configItem).length === 1 &&
      "$env" in configItem &&
      typeof configItem.$env === "string"
    ) {
      const value = process.env[configItem.$env];
      if (value === undefined) {
        throw new Error(
          `Environment variable '${configItem.$env}' is not defined`,
        );
      }
      return value;
    }

    if (
      Object.keys(configItem).length === 1 &&
      "$env" in configItem &&
      typeof configItem.$env !== "string"
    ) {
      throw new Error(
        `The value of '$env' must be a string, got: ${typeof configItem.$env}`,
      );
    }

    if (Object.keys(configItem).length === 1 && "$not" in configItem) {
      const pattern = evalJSONConfig(configItem.$not);
      /** @param {unknown} value */
      return (value) => {
        if (typeof pattern === "string") {
          return value !== pattern;
        }
        if (pattern instanceof RegExp) {
          return typeof value !== "string" || !pattern.test(value);
        }
        if (typeof pattern === "function") {
          return !pattern(value);
        }
        return true;
      };
    }

    if (Object.keys(configItem).length === 1 && "$has" in configItem) {
      const pattern = evalJSONConfig(configItem.$has);
      /** @param {unknown} value */
      return (value) => {
        if (!Array.isArray(value)) return false;
        return value.some((item) => {
          if (typeof pattern === "string") {
            return item === pattern;
          }
          if (pattern instanceof RegExp) {
            return typeof item === "string" && pattern.test(item);
          }
          if (typeof pattern === "function") {
            return pattern(item);
          }
          return false;
        });
      };
    }

    if (Object.keys(configItem).length === 1 && "$count" in configItem) {
      const { of, max } = /** @type {{ of: unknown; max: number }} */ (
        configItem.$count
      );
      const pattern = evalJSONConfig(of);
      /** @param {unknown} value */
      return (value) => {
        if (!Array.isArray(value)) return false;
        let count = 0;
        for (const item of value) {
          if (typeof pattern === "string") {
            if (item === pattern) count++;
          } else if (pattern instanceof RegExp) {
            if (typeof item === "string" && pattern.test(item)) count++;
          } else if (typeof pattern === "function") {
            if (pattern(item)) count++;
          }
        }
        return count > max;
      };
    }

    /** @type {Record<string,unknown>} */
    const clone = {};
    for (const [k, v] of Object.entries(configItem)) {
      clone[k] = evalJSONConfig(v);
    }
    return clone;
  }

  return configItem;
}
