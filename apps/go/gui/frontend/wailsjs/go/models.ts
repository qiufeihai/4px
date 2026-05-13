export namespace main {
	
	export class AppInfo {
	    clientVersion: string;
	    gitSha: string;
	    buildTime: string;
	
	    static createFrom(source: any = {}) {
	        return new AppInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.clientVersion = source["clientVersion"];
	        this.gitSha = source["gitSha"];
	        this.buildTime = source["buildTime"];
	    }
	}
	export class ClientStatus {
	    running: boolean;
	    pid: number;
	    configPath: string;
	    lastStartedAt: string;
	    lastExitedAt: string;
	    lastError: string;
	
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
	    }
	}
	export class SessionStatus {
	    ok: boolean;
	    error?: string;
	    expireAt?: string;
	    remainingDays: number;
	    expired: boolean;
	    serverTime?: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.error = source["error"];
	        this.expireAt = source["expireAt"];
	        this.remainingDays = source["remainingDays"];
	        this.expired = source["expired"];
	        this.serverTime = source["serverTime"];
	    }
	}

}

