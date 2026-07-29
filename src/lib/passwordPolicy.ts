export const minimumNewPasswordLength = 8;

export function newPasswordMeetsMinimum(password: string) {
  return Array.from(password).length >= minimumNewPasswordLength;
}
