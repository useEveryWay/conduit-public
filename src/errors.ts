export class ContractRejection extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "ContractRejection";
  }
}

export class SessionNotFound extends Error {
  readonly statusCode = 404;

  constructor(routeSessionId: string) {
    super(`unknown route session ${routeSessionId}`);
    this.name = "SessionNotFound";
  }
}

export class MissingPackageError extends Error {
  readonly statusCode = 503;
  readonly packageName: string;

  constructor(packageName: string, detail: string) {
    super(`missing package: ${packageName}. ${detail}`);
    this.name = "MissingPackageError";
    this.packageName = packageName;
  }
}
