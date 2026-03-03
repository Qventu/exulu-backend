export const mapExuluFieldTypesToGraphqlTypes = (field: any) => {
    let type: string;
    switch (field.type) {
      case "text":
      case "shortText":
      case "longText":
      case "markdown":
      case "code":
        type = "String";
        break;
      case "enum":
        type = field.enumValues ? `${field.name}Enum` : "String";
        break;
      case "number":
        type = "Float";
        break;
      case "boolean":
        type = "Boolean";
        break;
      case "json":
        type = "JSON";
        break;
      case "date":
        type = "Date";
        break;
      default:
        type = "String";
    }
    return type;
  };