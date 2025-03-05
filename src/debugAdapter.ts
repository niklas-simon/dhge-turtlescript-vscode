import { DebugProtocol } from '@vscode/debugprotocol';
import fs from 'fs';
import CAPABILITIES from './capabilities';
import { ChildProcess, exec, spawn } from 'child_process';
import { basename } from 'path';

type LaunchRequest = DebugProtocol.LaunchRequest & {
	arguments: {
		program: string,
		stopOnEntry?: boolean
	}
};

type RestartRequest = DebugProtocol.RestartRequest & {
	arguments: {
		arguments: LaunchRequest["arguments"]
	}
};

const logFile = "C:\\Users\\nikla\\Desktop\\projects\\dhge-turtlescript-vscode\\out.log";
const debugProg = "C:\\Users\\nikla\\Desktop\\projects\\dhge-compilerbau\\turtle\\turtle.exe";
let debugProc: ChildProcess | null = null;

let launchArgs: LaunchRequest["arguments"] | null = null;

let seq = 1;

fs.appendFileSync(logFile, "\r\n---\r\n");

const log = (msg: string) => fs.appendFileSync(logFile, msg + "\r\n");

const write = (res: DebugProtocol.Response | DebugProtocol.Event) => {
	log(`sending:\r\n${JSON.stringify(res, null, 4)}\r\n`);
	const str = JSON.stringify(res);
	process.stdout.write(`Content-Length: ${str.length}\r\n\r\n${str}`);
};

const createRes = <T extends DebugProtocol.Response>(req: DebugProtocol.Request, body: T["body"]) => {
	return {
		command: req.command,
		request_seq: req.seq,
		seq: seq++,
		success: true,
		type: "response",
		body: body
	} as T;
};

const createEvent = <T extends DebugProtocol.Event>(event: string, body: T["body"]) => {
	return {
		event: event,
		seq: seq++,
		type: "event",
		body: body
	} as T;
};

const error = (req: DebugProtocol.Request, error: string) => {
	write(createRes<DebugProtocol.ErrorResponse>(req, {
		error: {
			format: error,
			id: 0
		}
	}));
};

const initialize = (req: DebugProtocol.InitializeRequest) => {
	write(createRes<DebugProtocol.InitializeResponse>(req, CAPABILITIES));

	write(createEvent<DebugProtocol.InitializedEvent>("initialized", undefined));
};

const spawnDebugger = (args: LaunchRequest["arguments"]) => {
	debugProc = spawn(debugProg, [args.program, "-d"], {
		stdio: ["pipe", "pipe", "pipe"],
		shell: true
	});

	debugProc.stdout?.setEncoding("utf-8");
	debugProc.stdout?.on("data", (data) => {
		write(createEvent<DebugProtocol.OutputEvent>("output", {
			output: data
		}));

		const match = data.match(/currently at (?<line>\d+):(?<col>\d+)( \[breakpoint: (?<breakpoint>\d+)\])?/);
		if (!match) {
			return;
		}

		write(createEvent<DebugProtocol.StoppedEvent>("stopped", {
			reason: match.groups?.breakpoint ? "breakpoint" : "step",
			threadId: 0
		}));
	});

	launchArgs = args;
};

const exitDebugger = async () => {
	const isExited = new Promise<void>((resolve, reject) => {
		log("d> trying to exit");
		const lastTimeout = setTimeout(() => reject(), 2000);
		const killTimeout = setTimeout(() => {
			if (debugProc && debugProc.exitCode === null) {
				log("d> killing");
				if (debugProc.kill()) {
					clearTimeout(lastTimeout);
					resolve();
				}
			}
		}, 1000);
		debugProc?.on("exit", () => {
			log("d> exit");
			clearTimeout(killTimeout);
			clearTimeout(lastTimeout);
			resolve();
		});
	});
	sendCommand("exit", true);

	await isExited;
	log("d> exited sucessfully");

	debugProc = null;
};

const sendCommand = (args: string | string[], silent?: boolean) => {
	return new Promise<string>((resolve, reject) => {
		if (!silent) {
			debugProc?.stdout?.once("data", data => {
				log(data);
				resolve(data);
			});
		}
	
		const command = `${typeof args === "string" ? args : args.join(" ")}\n`;
		log(`> ${command}`);
		debugProc?.stdin?.write(command);

		if (silent) {
			resolve("");
		}
	});
};

const launch = (req: LaunchRequest) => {
	if (debugProc) {
		error(req, "already launched");
		return;
	}

	spawnDebugger(req.arguments);

	write(createRes<DebugProtocol.LaunchResponse>(req, undefined));
};

const setBreakpoints = (req: DebugProtocol.SetBreakpointsRequest) => {
	if (!debugProc) {
		error(req, "debugger not yet launched");
		return;
	}

	sendCommand(`rbreak\n`, true);
	req.arguments.breakpoints?.forEach(breakpoint => {
		sendCommand(["break", String(breakpoint.line)], true);
	});

	write(createRes<DebugProtocol.SetBreakpointsResponse>(req, {
		breakpoints: req.arguments.breakpoints?.map(b => ({...b, verified: true})) || []
	}));
};

const configurationDone = (req: DebugProtocol.ConfigurationDoneRequest) => {
	if (launchArgs?.stopOnEntry) {
		sendCommand("step", true);
	} else {
		sendCommand("run", true);
	}

	write(createRes<DebugProtocol.ConfigurationDoneResponse>(req, undefined));
};

const threads = (req: DebugProtocol.ThreadsRequest) => {
	write(createRes<DebugProtocol.ThreadsResponse>(req, {
		threads: [
			{
				id: 0,
				name: "Main"
			}
		]
	}));
};

const stackTrace = async (req: DebugProtocol.StackTraceRequest) => {
	const data = await sendCommand("stacktrace");

	const frames: DebugProtocol.StackFrame[] = data.split("\n")
		.map((frame: string) => {
			return frame.match(/(?<id>\d+) (?<name>\S+) (?<line>\d+):(?<col>\d+)/)?.groups;
		})
		.filter((frame: {[key: string]: string} | undefined) => frame)
		.map((frame: {[key: string]: string} | undefined) => {
			return {
				column: Number(frame!.col),
				id: Number(frame!.id),
				line: Number(frame!.line),
				name: frame!.name,
				source: {
					name: launchArgs ? basename(launchArgs.program) : undefined,
					path: launchArgs ? launchArgs.program : undefined
				}
			} satisfies DebugProtocol.StackFrame;
		});
	write(createRes<DebugProtocol.StackTraceResponse>(req, {
		stackFrames: frames,
		totalFrames: frames.length
	}));
};

const next = (req: DebugProtocol.NextRequest) => {
	sendCommand("step", true);
	write(createRes<DebugProtocol.NextResponse>(req, undefined));
};

const continueExecution = (req: DebugProtocol.ContinueRequest) => {
	sendCommand("run", true);
	write(createRes<DebugProtocol.ContinueResponse>(req, {}));
};

const stepIn = (req: DebugProtocol.StepInRequest) => {
	sendCommand("step in", true);
	write(createRes<DebugProtocol.StepInResponse>(req, undefined));
};

const stepOut = (req: DebugProtocol.StepOutRequest) => {
	sendCommand("step out", true);
	write(createRes<DebugProtocol.StepOutResponse>(req, undefined));
};

const disconnect = async (req: DebugProtocol.DisconnectRequest) => {
	await exitDebugger();

	write(createRes<DebugProtocol.DisconnectResponse>(req, undefined));
};

const scopes = (req: DebugProtocol.ScopesRequest) => {
	write(createRes<DebugProtocol.ScopesResponse>(req, {
		scopes: [
			{
				expensive: false,
				name: "Stack Frame",
				variablesReference: req.arguments.frameId + 1
			}
		]
	}));
};

const variables = async (req: DebugProtocol.VariablesRequest) => {
	const data = await sendCommand(["variables", String(req.arguments.variablesReference - 1)]);

	const variables = data.split("\n")
		.map((variable: string) => variable.match(/(?<name>\S+) (?<value>\d+(\.\d+)?)/)?.groups)
		.filter((variable: {[key: string]: string} | undefined) => variable)
		.map((variable: {[key: string]: string} | undefined) => ({
			name: variable!.name,
			value: variable!.value,
			variablesReference: 0
		} satisfies DebugProtocol.Variable));

	write(createRes<DebugProtocol.VariablesResponse>(req, { variables }));
};

const evaluate = async (req: DebugProtocol.EvaluateRequest) => {
	const data = await sendCommand(["evaluate", String(req.arguments.frameId), req.arguments.expression]);

	write(createRes<DebugProtocol.EvaluateResponse>(req, {
		result: data,
		variablesReference: 0
	}));
};

const processRequest = (req: DebugProtocol.Request) => {
	log(`processing:\r\n${JSON.stringify(req, null, 4)}\r\n`);

	switch (req.command) {
		case "initialize":
			initialize(req as DebugProtocol.InitializeRequest);
			break;
		case "launch":
			launch(req as LaunchRequest);
			break;
		case "setBreakpoints":
			setBreakpoints(req as DebugProtocol.SetBreakpointsRequest);
			break;
		case "configurationDone":
			configurationDone(req as DebugProtocol.ConfigurationDoneRequest);
			break;
		case "threads":
			threads(req as DebugProtocol.ThreadsRequest);
			break;
		case "stackTrace":
			stackTrace(req as DebugProtocol.StackTraceRequest);
			break;
		case "next":
			next(req as DebugProtocol.NextRequest);
			break;
		case "continue":
			continueExecution(req as DebugProtocol.ContinueRequest);
			break;
		case "stepIn":
			stepIn(req as DebugProtocol.StepInRequest);
			break;
		case "stepOut":
			stepOut(req as DebugProtocol.StepOutRequest);
			break;
		case "disconnect":
			disconnect(req as DebugProtocol.DisconnectRequest);
			break;
		case "scopes":
			scopes(req as DebugProtocol.ScopesRequest);
			break;
		case "variables":
			variables(req as DebugProtocol.VariablesRequest);
			break;
		case "evaluate":
			evaluate(req as DebugProtocol.EvaluateRequest);
			break;
		default:
			error(req, "not implemented");
			break;
	}
};

process.stdin.on("data", async data => {
	const parts = data.toString("utf-8").split("\r\n");
	let i = 0;
	for (i = 0; i < parts.length; i++) {
		if (!parts[i].length) {
			break;
		}
	}
	const request = JSON.parse(parts.slice(i + 1).join("\r\n")) as DebugProtocol.Request;

	processRequest(request);
});