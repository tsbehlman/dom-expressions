import * as t from "@babel/types";
import {
  Attributes,
  SVGAttributes,
  NonComposedEvents,
  SVGElements
} from "dom-expressions/src/constants";
import VoidElements from "../VoidElements";
import config from "../config";
import {
  getTagName,
  isDynamic,
  isComponent,
  registerImportMethod,
  filterChildren,
  toEventName,
  checkLength,
  isStaticExpressionContainer
} from "../shared/utils";
import { transformNode } from "../shared/transform";

export function transformElement(path, info) {
  let tagName = getTagName(path.node),
    wrapSVG = info.topLevel && tagName != "svg" && SVGElements.has(tagName),
    voidTag = VoidElements.indexOf(tagName) > -1,
    results = {
      template: `<${tagName}`,
      decl: [],
      exprs: [],
      dynamics: [],
      postExprs: [],
      isSVG: wrapSVG
    };
  if (wrapSVG) results.template = "<svg>" + results.template;
  if (!info.skipId) results.id = path.scope.generateUidIdentifier("el$");
  transformAttributes(path, results);
  if (config.contextToCustomElements && (tagName === "slot" || tagName.indexOf("-") > -1)) {
    contextToCustomElement(path, results);
  }
  results.template += ">";
  if (!voidTag) {
    transformChildren(path, results);
    results.template += `</${tagName}>`;
  }
  if (info.topLevel && config.hydratable && results.hasHydratableEvent) {
    registerImportMethod(path, "runHydrationEvents");
    results.postExprs.push(
      t.expressionStatement(
        t.callExpression(t.identifier("_$runHydrationEvents"), [
          t.callExpression(t.memberExpression(results.id, t.identifier("getAttribute")), [
            t.stringLiteral("_hk")
          ])
        ])
      )
    );
  }
  if (wrapSVG) results.template += "</svg>";
  return results;
}

export function setAttr(path, elem, name, value, isSVG, dynamic, prevId) {
  if (name.startsWith("style:")) {
    const key = name.slice(6);
    return t.callExpression(
      t.memberExpression(
        t.memberExpression(elem, t.identifier("style")),
        t.identifier("setProperty")
      ),
      [t.stringLiteral(key), value]
    );
  }

  if (name === "style") {
    registerImportMethod(path, "style");
    return t.callExpression(
      t.identifier("_$style"),
      prevId ? [elem, value, prevId] : [elem, value]
    );
  }

  if (name === "classList") {
    registerImportMethod(path, "classList");
    return t.callExpression(
      t.identifier("_$classList"),
      prevId ? [elem, value, prevId] : [elem, value]
    );
  }

  if (dynamic && name === "textContent") {
    return t.assignmentExpression("=", t.memberExpression(elem, t.identifier("data")), value);
  }

  let isAttribute = isSVG || name.indexOf("-") > -1,
    attribute = isSVG ? SVGAttributes[name] : Attributes[name];

  if (attribute) {
    if (attribute.type === "attribute") isAttribute = true;
    if (attribute.alias) name = attribute.alias;
  } else if (isSVG) name = name.replace(/([A-Z])/g, g => `-${g[0].toLowerCase()}`);

  if (isAttribute)
    return t.callExpression(t.memberExpression(elem, t.identifier("setAttribute")), [
      t.stringLiteral(name),
      value
    ]);
  return t.assignmentExpression("=", t.memberExpression(elem, t.identifier(name)), value);
}

function transformAttributes(path, results) {
  let elem = results.id,
    hasHydratableEvent = false,
    children;
  const spread = t.identifier("_$spread"),
    tagName = getTagName(path.node),
    isSVG = SVGElements.has(tagName),
    hasChildren = path.node.children.length > 0,
    attributes = path.get("openingElement").get("attributes"),
    classAttributes = attributes.filter(
      a => a.node.name && (a.node.name.name === "class" || a.node.name.name === "className")
    );
  // combine class propertoes
  if (classAttributes.length > 1) {
    const first = classAttributes[0].node,
      values = [],
      quasis = [t.TemplateElement({ raw: "" })];
    for (let i = 0; i < classAttributes.length; i++) {
      const attr = classAttributes[i].node,
        isLast = i === classAttributes.length - 1;
      if (!t.isJSXExpressionContainer(attr.value)) {
        quasis.pop();
        quasis.push(
          t.TemplateElement({ raw: (i ? " " : "") + `${attr.value.value}` + (isLast ? "" : " ") })
        );
      } else {
        values.push(attr.value.expression);
        quasis.push(t.TemplateElement({ raw: isLast ? "" : " " }));
      }
      i && attributes.splice(classAttributes[i].key);
    }
    first.value = t.JSXExpressionContainer(t.TemplateLiteral(quasis, values));
  }
  path.get("openingElement").set(
    "attributes",
    attributes.map(a => a.node)
  );

  // preprocess styles
  const styleAttribute = attributes.find(
    a =>
      a.node.name &&
      a.node.name.name === "style" &&
      t.isJSXExpressionContainer(a.node.value) &&
      t.isObjectExpression(a.node.value.expression)
  );
  if (styleAttribute) {
    let i = 0,
      leading = styleAttribute.node.value.expression.leadingComments;
    styleAttribute.node.value.expression.properties.slice().forEach((p, index) => {
      if (!p.computed) {
        if (leading) p.value.leadingComments = leading;
        path
          .get("openingElement")
          .node.attributes.splice(
            styleAttribute.key + ++i,
            0,
            t.JSXAttribute(
              t.JSXNamespacedName(
                t.JSXIdentifier("style"),
                t.JSXIdentifier(t.isIdentifier(p.key) ? p.key.name : p.key.value)
              ),
              t.JSXExpressionContainer(p.value)
            )
          );
        styleAttribute.node.value.expression.properties.splice(index - i - 1, 1);
      }
    });
    if (!styleAttribute.node.value.expression.properties.length)
      path.get("openingElement").node.attributes.splice(styleAttribute.key, 1);
  }

  path
    .get("openingElement")
    .get("attributes")
    .forEach(attribute => {
      const node = attribute.node;
      if (t.isJSXSpreadAttribute(node)) {
        registerImportMethod(attribute, "spread");
        results.exprs.push(
          t.expressionStatement(
            t.callExpression(spread, [
              elem,
              isDynamic(attribute.get("argument"), {
                checkMember: true
              })
                ? t.arrowFunctionExpression([], node.argument)
                : node.argument,
              t.booleanLiteral(isSVG),
              t.booleanLiteral(hasChildren)
            ])
          )
        );
        //NOTE: can't be checked at compile time so add to compiled output
        hasHydratableEvent = true;
        return;
      }

      let value = node.value,
        key = t.isJSXNamespacedName(node.name)
          ? `${node.name.namespace.name}:${node.name.name.name}`
          : node.name.name;
      if (t.isJSXNamespacedName(node.name) && !t.isJSXExpressionContainer(value)) {
        node.value = value = t.JSXExpressionContainer(value);
      }
      if (
        t.isJSXExpressionContainer(value) &&
        (key.toLowerCase() !== key ||
          key.includes(":") ||
          !(t.isStringLiteral(value.expression) || t.isNumericLiteral(value.expression)))
      ) {
        if (key === "ref") {
          if (t.isLVal(value.expression)) {
            results.exprs.unshift(
              t.expressionStatement(
                t.conditionalExpression(
                  t.binaryExpression(
                    "===",
                    t.unaryExpression("typeof", value.expression),
                    t.stringLiteral("function")
                  ),
                  t.callExpression(value.expression, [elem]),
                  t.assignmentExpression("=", value.expression, elem)
                )
              )
            );
          } else if (t.isFunction(value.expression)) {
            results.exprs.unshift(
              t.expressionStatement(
                t.callExpression(value.expression, [elem])
              )
            );
          }
        } else if (key === "children") {
          children = value;
        } else if (key.startsWith("on")) {
          if (config.generate === "dom-ssr") return;
          const ev = toEventName(key);
          if (!ev || ev === "capture") {
            value.expression.properties.forEach(prop => {
              const listenerOptions = [
                t.stringLiteral(prop.key.name || prop.key.value),
                prop.value
              ];
              results.exprs.push(
                t.expressionStatement(
                  t.callExpression(
                    t.memberExpression(elem, t.identifier("addEventListener")),
                    ev ? listenerOptions.concat(t.booleanLiteral(true)) : listenerOptions
                  )
                )
              );
            });
          } else if (
            config.delegateEvents &&
            !NonComposedEvents.has(ev) &&
            config.nonDelegateEvents.indexOf(ev) === -1
          ) {
            // can only hydrate delegated events
            hasHydratableEvent = config.hydratableEvents
              ? config.hydratableEvents.includes(ev)
              : true;
            const events =
              attribute.scope.getProgramParent().data.events ||
              (attribute.scope.getProgramParent().data.events = new Set());
            events.add(ev);
            let handler = value.expression;
            if (t.isArrayExpression(value.expression)) {
              handler = value.expression.elements[0];
              results.exprs.unshift(
                t.expressionStatement(
                  t.assignmentExpression(
                    "=",
                    t.memberExpression(t.identifier(elem.name), t.identifier(`__${ev}Data`)),
                    value.expression.elements[1]
                  )
                )
              );
            }
            results.exprs.unshift(
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.memberExpression(t.identifier(elem.name), t.identifier(`__${ev}`)),
                  handler
                )
              )
            );
          } else {
            let handler = value.expression;
            if (t.isArrayExpression(value.expression)) {
              handler = t.arrowFunctionExpression(
                [t.identifier("e")],
                t.callExpression(value.expression.elements[0], [
                  value.expression.elements[1],
                  t.identifier("e")
                ])
              );
            }
            results.exprs.unshift(
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.memberExpression(t.identifier(elem.name), t.identifier(`on${ev}`)),
                  handler
                )
              )
            );
          }
        } else if (
          isDynamic(attribute.get("value").get("expression"), {
            checkMember: true
          })
        ) {
          let nextElem = elem;
          if (key === "textContent") {
            const textId = attribute.scope.generateUidIdentifier("el$");
            results.exprs.push(
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.memberExpression(elem, t.identifier("textContent")),
                  value.expression
                )
              ),
              t.variableDeclaration("const", [
                t.variableDeclarator(textId, t.memberExpression(elem, t.identifier("firstChild")))
              ])
            );
            nextElem = textId;
          }
          results.dynamics.push({ elem: nextElem, key, value: value.expression, isSVG });
        } else {
          results.exprs.push(
            t.expressionStatement(setAttr(attribute, elem, key, value.expression, isSVG))
          );
        }
      } else {
        if (t.isJSXExpressionContainer(value)) value = value.expression;
        if (isSVG) {
          const attr = SVGAttributes[key];

          if (attr) {
            if (attr.alias) key = attr.alias;
          } else key = key.replace(/([A-Z])/g, g => `-${g[0].toLowerCase()}`);
        } else {
          const attr = SVGAttributes[key];
          if (attr && attr.alias) key = attr.alias;
          key = key.toLowerCase();
        }
        results.template += ` ${key}`;
        results.template += value ? `="${value.value}"` : `=""`;
      }
    });
  if (!hasChildren && children) {
    path.node.children.push(children);
  }

  results.hasHydratableEvent = results.hasHydratableEvent || hasHydratableEvent;
}

function wrappedByText(list, startIndex) {
  let index = startIndex,
    wrapped;
  while (--index >= 0) {
    const node = list[index]
    if (!node) continue;
    if (node.text) {
      wrapped = true;
      break;
    }
    if (node.id) return false;
  }
  if (!wrapped) return false;
  index = startIndex;
  while (++index < list.length) {
    const node = list[index]
    if (!node) continue;
    if (node.text) return true;
    if (node.id) return false;
  }
  return false;
}

function transformChildren(path, results) {
  const { generate, hydratable } = config;
  let tempPath = results.id && results.id.name,
    nextPlaceholder,
    i = 0;
  const filteredChildren = filterChildren(path.get("children"), true),
    childNodes = filteredChildren.map((child, index) =>
      transformNode(child, {
        skipId: !results.id || !detectExpressions(filteredChildren, index)
      })
    // combine adjacent textNodes
    ).reduce((memo, child) => {
      const i = memo.length
      if (child.text && i && memo[i -1].text) {
        memo[i - 1].template += child.template;
      } else memo.push(child);
      return memo;
    }, []);

  childNodes.forEach((child, index) => {
    if (!child) return;
    results.template += child.template;
    if (child.id) {
      results.decl.push(
        t.variableDeclarator(
          child.id,
          t.memberExpression(
            t.identifier(tempPath),
            t.identifier(i === 0 ? "firstChild" : "nextSibling")
          )
        )
      );
      results.decl.push(...child.decl);
      results.exprs.push(...child.exprs);
      results.dynamics.push(...child.dynamics);
      results.hasHydratableEvent = results.hasHydratableEvent || child.hasHydratableEvent;
      tempPath = child.id.name;
      nextPlaceholder = null;
      i++;
    } else if (child.exprs.length) {
      registerImportMethod(path, "insert");
      const multi = checkLength(filteredChildren),
        markers = (generate === "dom-ssr" || hydratable) && multi;
      // boxed by textNodes
      if (
        markers ||
        wrappedByText(childNodes, index)
      ) {
        let exprId, contentId;
        if (markers) tempPath = createPlaceholder(path, results, tempPath, i++, "#")[0].name;
        if (nextPlaceholder) {
          exprId = nextPlaceholder;
        } else {
          [exprId, contentId] = createPlaceholder(
            path,
            results,
            tempPath,
            i++,
            markers ? "/" : ""
          );
        }
        if (!markers) nextPlaceholder = exprId;
        results.exprs.push(
          t.expressionStatement(
            t.callExpression(
              t.identifier("_$insert"),
              contentId
                ? [results.id, child.exprs[0], exprId, contentId]
                : [results.id, child.exprs[0], exprId]
            )
          )
        );
        tempPath = exprId.name;
      } else if (multi) {
        results.exprs.push(
          t.expressionStatement(
            t.callExpression(t.identifier("_$insert"), [
              results.id,
              child.exprs[0],
              nextChild(childNodes, index) || t.nullLiteral()
            ])
          )
        );
      } else {
        results.exprs.push(
          t.expressionStatement(
            t.callExpression(
              t.identifier("_$insert"),
              hydratable
                ? [
                    results.id,
                    child.exprs[0],
                    t.identifier("undefined"),
                    t.callExpression(
                      t.memberExpression(
                        t.memberExpression(
                          t.memberExpression(t.identifier("Array"), t.identifier("prototype")),
                          t.identifier("slice")
                        ),
                        t.identifier("call")
                      ),
                      [
                        t.memberExpression(results.id, t.identifier("childNodes")),
                        t.numericLiteral(0)
                      ]
                    )
                  ]
                : [results.id, child.exprs[0]]
            )
          )
        );
      }
    } else nextPlaceholder = null;
  });
}

function createPlaceholder(path, results, tempPath, i, char) {
  const exprId = path.scope.generateUidIdentifier("el$");
  let contentId;
  results.template += `<!--${char}-->`;
  if (config.hydratable && char === "/") {
    registerImportMethod(path, "getNextMarker");
    contentId = path.scope.generateUidIdentifier("co$");
    results.decl.push(
      t.variableDeclarator(
        t.arrayPattern([exprId, contentId]),
        t.callExpression(t.identifier("_$getNextMarker"), [
          t.memberExpression(t.identifier(tempPath), t.identifier("nextSibling"))
        ])
      )
    );
  } else
    results.decl.push(
      t.variableDeclarator(
        exprId,
        t.memberExpression(
          t.identifier(tempPath),
          t.identifier(i === 0 ? "firstChild" : "nextSibling")
        )
      )
    );
  return [exprId, contentId];
}

function nextChild(children, index) {
  return children[index + 1] && (children[index + 1].id || nextChild(children, index + 1));
}

// reduce unnecessary refs
function detectExpressions(children, index) {
  if (children[index - 1]) {
    const node = children[index - 1].node;
    if (
      t.isJSXExpressionContainer(node) &&
      !t.isJSXEmptyExpression(node.expression) &&
      !isStaticExpressionContainer(children[index - 1])
    )
      return true;
    let tagName;
    if (t.isJSXElement(node) && (tagName = getTagName(node)) && isComponent(tagName)) return true;
  }
  for (let i = index; i < children.length; i++) {
    const child = children[i].node;
    if (t.isJSXExpressionContainer(child)) {
      if (!t.isJSXEmptyExpression(child.expression) && !isStaticExpressionContainer(children[i]))
        return true;
    } else if (t.isJSXElement(child)) {
      const tagName = getTagName(child);
      if (isComponent(tagName)) return true;
      if (config.contextToCustomElements && (tagName === "slot" || tagName.indexOf("-") > -1))
        return true;
      if (
        child.openingElement.attributes.some(
          attr =>
            t.isJSXSpreadAttribute(attr) ||
            (t.isJSXExpressionContainer(attr.value) &&
              (config.generate !== "dom-ssr" || !attr.name.name.startsWith("on")) &&
              (attr.name.name.toLowerCase() !== attr.name.name ||
                !(
                  t.isStringLiteral(attr.value.expression) ||
                  t.isNumericLiteral(attr.value.expression)
                )))
        )
      )
        return true;
      const nextChildren = filterChildren(children[i].get("children"), true);
      if (nextChildren.length) if (detectExpressions(nextChildren, 0)) return true;
    }
  }
}

function contextToCustomElement(path, results) {
  registerImportMethod(path, "currentContext");
  results.exprs.push(
    t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(results.id, t.identifier("_context")),
        t.callExpression(t.identifier("_$currentContext"), [])
      )
    )
  );
}
