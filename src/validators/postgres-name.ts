// Add a helper function to validate PostgreSQL table names
export const isValidPostgresName = (id: string): boolean => {
    const regex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    const isValid = regex.test(id);
    const length = id.length;
    return isValid && length <= 80 && length > 2;
  };