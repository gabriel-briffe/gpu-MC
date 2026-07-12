/** Convert OpenAIP token strings like `{type}-small` to MapLibre expressions. */
export function tokenExpression(token) {
  if (!token.includes("{")) {
    return token;
  }

  const parts = token.split(/(\{[^}]+\})/).filter(Boolean);
  const expression = ["concat"];
  for (const part of parts) {
    if (part.startsWith("{") && part.endsWith("}")) {
      expression.push(["get", part.slice(1, -1)]);
    } else {
      expression.push(part);
    }
  }

  return expression.length === 2 ? expression[1] : expression;
}

function stopValue(property, value) {
  if (property === "icon-image" || property === "text-field") {
    return tokenExpression(value);
  }
  if (Array.isArray(value)) {
    return ["literal", value];
  }
  return value;
}

function literalValue(value) {
  if (Array.isArray(value)) {
    return ["literal", value];
  }
  return value;
}

/** Linear zoom ramp (OpenAIP legacy "stops" for numeric layout/paint properties). */
export function zoomInterpolate(stops) {
  const expression = ["interpolate", ["linear"], ["zoom"]];
  for (const [zoom, value] of stops) {
    expression.push(zoom, literalValue(value));
  }
  return expression;
}

export function zoomStep(property, stops) {
  if (stops.length === 1) {
    return stopValue(property, stops[0][1]);
  }

  const expression = ["step", ["zoom"]];
  for (let index = 0; index < stops.length; index += 1) {
    const [zoom, value] = stops[index];
    const resolved = stopValue(property, value);
    if (index === 0) {
      expression.push(resolved);
    } else {
      expression.push(zoom, resolved);
    }
  }
  return expression;
}
