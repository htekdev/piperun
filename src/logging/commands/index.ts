// Command handler registry and all built-in command handlers.

import type { LoggingCommand } from '../command-parser.js';
import type { VariableManager } from '../../variables/variable-manager.js';
import type { SecretMasker } from '../../variables/secret-masker.js';

export type CommandHandler = (
  command: LoggingCommand,
  context: CommandContext,
) => void;

export interface CommandContext {
  variableManager: VariableManager;
  secretMasker: SecretMasker;
  jobName: string;
  stepName: string;
  outputs: Map<string, string>;
  tags: Set<string>;
  runNumber: string;
  progress: { percent: number; description: string };
  warnings: string[];
  errors: string[];
  uploadedFiles: string[];
  uploadedSummaries: string[];
  completionResult?: string;
  logDetails: Array<{
    id: string;
    parentId?: string;
    type?: string;
    message: string;
  }>;
}

/**
 * Create the default command handler registry with all built-in handlers.
 */
export function createCommandRegistry(): Map<string, CommandHandler> {
  const registry = new Map<string, CommandHandler>();

  registry.set('setvariable', handleSetVariable);
  registry.set('logissue', handleLogIssue);
  registry.set('complete', handleComplete);
  registry.set('setprogress', handleSetProgress);
  registry.set('addbuildtag', handleAddBuildTag);
  registry.set('updatebuildnumber', handleUpdateBuildNumber);
  registry.set('prependpath', handlePrependPath);
  registry.set('uploadfile', handleUploadFile);
  registry.set('uploadsummary', handleUploadSummary);
  registry.set('logdetail', handleLogDetail);

  return registry;
}

/**
 * ##pipeline[setvariable variable=name;isOutput=true;isSecret=false]value
 *
 * Sets a variable in VariableManager.
 * If isOutput=true, records as output variable.
 * If isSecret=true, registers with SecretMasker.
 */
function handleSetVariable(command: LoggingCommand, context: CommandContext): void {
  const varName = command.properties['variable'];
  if (!varName) return;

  const isOutput = command.properties['isOutput']?.toLowerCase() === 'true';
  const isSecret = command.properties['isSecret']?.toLowerCase() === 'true';
  const value = command.value;

  context.variableManager.set(varName, value, {
    isOutput,
    isSecret,
    source: 'output',
  });

  if (isOutput) {
    context.outputs.set(varName, value);
  }

  if (isSecret) {
    context.secretMasker.addSecret(value);
  }
}

/**
 * ##pipeline[logissue type=warning]This is a warning
 *
 * Records a warning or error to context.
 */
function handleLogIssue(command: LoggingCommand, context: CommandContext): void {
  const issueType = command.properties['type']?.toLowerCase();
  const message = command.value;

  if (issueType === 'error') {
    context.errors.push(message);
  } else {
    // Default to warning for unknown types
    context.warnings.push(message);
  }
}

/**
 * ##pipeline[complete result=Succeeded]Done
 *
 * Sets step completion result.
 */
function handleComplete(command: LoggingCommand, context: CommandContext): void {
  const result = command.properties['result'];
  if (result) {
    context.completionResult = result;
  }
}

/**
 * ##pipeline[setprogress value=50]Halfway done
 *
 * Updates progress percent and description.
 */
function handleSetProgress(command: LoggingCommand, context: CommandContext): void {
  const valueStr = command.properties['value'];
  if (valueStr !== undefined) {
    const percent = parseInt(valueStr, 10);
    if (!Number.isNaN(percent)) {
      context.progress.percent = Math.max(0, Math.min(100, percent));
    }
  }
  if (command.value) {
    context.progress.description = command.value;
  }
}

/**
 * ##pipeline[addbuildtag]my-tag
 *
 * Adds a tag to context.tags.
 */
function handleAddBuildTag(command: LoggingCommand, context: CommandContext): void {
  const tag = command.value.trim();
  if (tag) {
    context.tags.add(tag);
  }
}

/**
 * ##pipeline[updatebuildnumber]1.2.3
 *
 * Updates context.runNumber.
 */
function handleUpdateBuildNumber(command: LoggingCommand, context: CommandContext): void {
  const newNumber = command.value.trim();
  if (newNumber) {
    context.runNumber = newNumber;
  }
}

/**
 * ##pipeline[prependpath]/usr/local/bin
 *
 * Prepends a directory to the PATH environment variable.
 */
function handlePrependPath(command: LoggingCommand, _context: CommandContext): void {
  const dir = command.value.trim();
  if (dir) {
    const separator = process.platform === 'win32' ? ';' : ':';
    const currentPath = process.env['PATH'] ?? '';
    process.env['PATH'] = dir + separator + currentPath;
  }
}

/**
 * ##pipeline[uploadfile]/path/to/file
 *
 * Records file path for artifact collection.
 */
function handleUploadFile(command: LoggingCommand, context: CommandContext): void {
  const filePath = command.value.trim();
  if (filePath) {
    context.uploadedFiles.push(filePath);
  }
}

/**
 * ##pipeline[uploadsummary]/path/to/summary.md
 *
 * Records summary file.
 */
function handleUploadSummary(command: LoggingCommand, context: CommandContext): void {
  const filePath = command.value.trim();
  if (filePath) {
    context.uploadedSummaries.push(filePath);
  }
}

/**
 * ##pipeline[logdetail id=guid;parentId=guid;type=build]message
 *
 * Detailed timeline logging.
 */
function handleLogDetail(command: LoggingCommand, context: CommandContext): void {
  const id = command.properties['id'];
  if (!id) return;

  context.logDetails.push({
    id,
    parentId: command.properties['parentId'],
    type: command.properties['type'],
    message: command.value,
  });
}
