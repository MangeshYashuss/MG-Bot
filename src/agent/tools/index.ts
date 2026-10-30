import { runCommandTool } from './commandTool';
import { createFileTool, editFileTool } from './editTools';
import { listDirTool, readFileTool, searchCodeTool, semanticSearchTool } from './fsTools';
import { recallTool, rememberTool } from './memoryTools';
import { todoWriteTool } from './todoTool';
import { Tool } from './types';

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  searchCodeTool,
  semanticSearchTool,
  editFileTool,
  createFileTool,
  runCommandTool,
  rememberTool,
  recallTool,
  todoWriteTool,
];
