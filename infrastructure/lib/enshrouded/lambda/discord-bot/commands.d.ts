export interface CommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  options?: CommandOption[];
}
export interface Command {
  name: string;
  description: string;
  type?: number;
  default_member_permissions?: string;
  dm_permission?: boolean;
  options?: CommandOption[];
}
export const commands: Command[];
export const OPTION_TYPE: { SUB_COMMAND: number; SUB_COMMAND_GROUP: number; STRING: number; INTEGER: number };
