// Parses ##pipeline[command key=value;key=value]message logging commands from step output.

export interface LoggingCommand {
  command: string;
  properties: Record<string, string>;
  value: string;
}

const LOGGING_COMMAND_REGEX = /^##pipeline\[(\w+)((?:\s+\w+=(?:[^;\]]*;?)*)?)\]([\s\S]*)$/;

/**
 * Parse a line of output for a logging command.
 * Pattern: `##pipeline[command key1=value1;key2=value2]message`
 *
 * - Command name: word characters after `[`
 * - Properties: space-separated from command, semicolon-separated key=value pairs
 * - Value: everything after `]`
 */
export function parseLoggingCommand(line: string): LoggingCommand | null {
  if (!line.startsWith('##pipeline[')) {
    return null;
  }

  // Find the command name (word chars right after the opening bracket)
  const bracketStart = '##pipeline['.length;
  let i = bracketStart;
  while (i < line.length && /\w/.test(line[i])) {
    i++;
  }
  if (i === bracketStart) {
    return null; // no command name
  }
  const command = line.substring(bracketStart, i);

  // Find the closing bracket
  const closingBracket = line.indexOf(']', i);
  if (closingBracket === -1) {
    return null; // malformed — no closing bracket
  }

  // Properties string is between command end and closing bracket
  const propsStr = line.substring(i, closingBracket).trim();

  // Value is everything after the closing bracket
  const value = line.substring(closingBracket + 1);

  // Parse properties: semicolon-separated key=value pairs
  const properties: Record<string, string> = {};
  if (propsStr.length > 0) {
    const pairs = propsStr.split(';');
    for (const pair of pairs) {
      const trimmed = pair.trim();
      if (trimmed.length === 0) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        const val = trimmed.substring(eqIndex + 1);
        properties[key] = val;
      }
    }
  }

  return { command, properties, value };
}

/**
 * Format a logging command back into its string representation.
 * Useful for testing and documentation.
 */
export function formatLoggingCommand(cmd: LoggingCommand): string {
  const entries = Object.entries(cmd.properties);
  const propsStr =
    entries.length > 0
      ? ' ' + entries.map(([k, v]) => `${k}=${v}`).join(';')
      : '';
  return `##pipeline[${cmd.command}${propsStr}]${cmd.value}`;
}
