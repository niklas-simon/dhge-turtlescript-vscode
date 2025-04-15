import path from 'path';
import * as vscode from 'vscode';

export class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        console.log(process.cwd(), session, executable);
        
        const config = {
            args: executable.args,
            command: executable.command,
            options: Object.assign(executable.options || {}, {
                cwd: path.dirname(executable.args[0]),
                env: {
                    DEBUGGER_PATH: vscode.workspace.getConfiguration("turtlescript").get("debuggerPath") as string
                }
            })
        };

        return new vscode.DebugAdapterExecutable(config.command, config.args, config.options);
    }

}