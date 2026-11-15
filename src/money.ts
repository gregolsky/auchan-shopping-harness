export const zl = (grosze: number): string => `${(grosze / 100).toFixed(2).replace('.', ',')} zł`.replace(/\B(?=(\d{3})+(?=,))/g, ' ');
