/**
 * iOS 15.0 ~ 15.3（Safari < 15.4）没有 `Array/String.prototype.at`，
 * 项目里大量用到，这里补一个最小的实现。
 * 注意：这个文件由 home.tsx 用 require 提前加载，保证在渲染之前生效。
 */
declare global {
  interface Array<T> {
    at(index: number): T | undefined;
  }
  interface String {
    at(index: number): string | undefined;
  }
}

if (!Array.prototype.at) {
  Array.prototype.at = function (index: number) {
    // Get the length of the array
    const length = this.length;

    // Convert negative index to a positive index
    if (index < 0) {
      index = length + index;
    }

    // Return undefined if the index is out of range
    if (index < 0 || index >= length) {
      return undefined;
    }

    // Use Array.prototype.slice method to get value at the specified index
    return Array.prototype.slice.call(this, index, index + 1)[0];
  };
}

if (!String.prototype.at) {
  String.prototype.at = function (index: number) {
    const length = this.length;

    if (index < 0) {
      index = length + index;
    }

    if (index < 0 || index >= length) {
      return undefined;
    }

    return this.charAt(index);
  };
}

export {};
