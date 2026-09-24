/**
 * What to log when stored JSON fails to parse. V8 quotes the input in the
 * error message (`Unexpected token 'm', "my passwor"... is not valid JSON`),
 * and the input is user data, so only the error's type goes to the log file.
 */
export function parseErrorKind(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}
