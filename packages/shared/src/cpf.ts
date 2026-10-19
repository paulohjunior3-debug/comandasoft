/** Remove tudo que não for dígito. */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Valida CPF pelos dígitos verificadores. Aceita com ou sem máscara. */
export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const digits = cpf.split('').map(Number);
  const checkDigit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i]! * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return checkDigit(9) === digits[9] && checkDigit(10) === digits[10];
}

/** "12345678909" → "123.456.789-09" */
export function formatCpf(value: string): string {
  const cpf = onlyDigits(value).padStart(11, '0').slice(-11);
  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

/** Três últimos dígitos, usados como PIN do QR do cliente. */
export function cpfLast3(value: string): string {
  return onlyDigits(value).slice(-3);
}
