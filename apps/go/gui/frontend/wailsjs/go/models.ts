export namespace main {
	
	export class ClientStatus {
	    running: boolean;
	    pid: number;
	    configPath: string;
	    lastStartedAt: string;
	    lastExitedAt: string;
	    lastError: string;
	    muxConnected: boolean;
	    muxReconnectTotal: number;
	    muxLastReconnectErr: string;
	
	    static createFrom(source: any = {}) {
	        return new ClientStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.running = source["running"];
	        this.pid = source["pid"];
	        this.configPath = source["configPath"];
	        this.lastStartedAt = source["lastStartedAt"];
	        this.lastExitedAt = source["lastExitedAt"];
	        this.lastError = source["lastError"];
	        this.muxConnected = source["muxConnected"];
	        this.muxReconnectTotal = source["muxReconnectTotal"];
	        this.muxLastReconnectErr = source["muxLastReconnectErr"];
	    }
	}

}

