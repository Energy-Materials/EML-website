(function (global) {
  'use strict';

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function validate(value) {
    const errors = [];
    if (!isRecord(value)) return { valid: false, errors: ['최상위 데이터는 객체여야 합니다.'] };

    ['site', 'home', 'professor'].forEach((key) => {
      if (!isRecord(value[key])) errors.push(`${key}는 객체여야 합니다.`);
    });

    const recordArrays = ['researchTopics', 'members', 'alumni', 'publications', 'patents', 'gallery'];
    recordArrays.forEach((key) => {
      if (!Array.isArray(value[key])) {
        errors.push(`${key}는 배열이어야 합니다.`);
        return;
      }
      if (!value[key].every(isRecord)) errors.push(`${key}의 모든 항목은 객체여야 합니다.`);
    });

    if (isRecord(value.home)) {
      if (!Array.isArray(value.home.titleLines)) {
        errors.push('home.titleLines는 배열이어야 합니다.');
      } else if (!value.home.titleLines.every((item) => typeof item === 'string')) {
        errors.push('home.titleLines의 모든 항목은 문자열이어야 합니다.');
      }
    }

    if (isRecord(value.professor)) {
      ['interest', 'education', 'experience'].forEach((key) => {
        if (value.professor[key] != null) {
          if (!Array.isArray(value.professor[key])) {
            errors.push(`professor.${key}는 배열이어야 합니다.`);
          } else if (!value.professor[key].every((item) => typeof item === 'string')) {
            errors.push(`professor.${key}의 모든 항목은 문자열이어야 합니다.`);
          }
        }
      });
    }

    if (Array.isArray(value.gallery)) {
      value.gallery.forEach((item, index) => {
        if (isRecord(item) && item.images != null) {
          if (!Array.isArray(item.images)) {
            errors.push(`gallery.${index}.images는 배열이어야 합니다.`);
          } else if (!item.images.every((image) => typeof image === 'string')) {
            errors.push(`gallery.${index}.images의 모든 항목은 문자열이어야 합니다.`);
          }
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  function assertValid(value) {
    const result = validate(value);
    if (!result.valid) throw new Error(result.errors.join(' '));
    return value;
  }

  global.EMLDataSchema = Object.freeze({ validate, assertValid });
})(window);
