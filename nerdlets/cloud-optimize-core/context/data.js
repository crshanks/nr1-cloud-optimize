/* eslint 
no-console: 0,
no-async-promise-executor: 0,
no-func-assign: 0,
require-atomic-updates: 0,
no-unused-vars: 0
*/

import React, { Component } from 'react';
import { ToastContainer, toast } from 'react-toastify';
import { NerdGraphQuery } from 'nr1';
import {
  chunk,
  getTagValue,
  getCollection,
  getEntityCollection,
  getAccountCollection,
  existsInObjArray,
  roundHalf,
  buildTags
} from '../../shared/lib/utils';
import {
  entitySearchQuery,
  getWorkloadTags,
  workloadQueries,
  getEntityDataQuery
} from '../../shared/lib/queries';
import _ from 'lodash';
import { addInstanceCostTotal } from '../strategies/instances';
import pkg from '../../../package.json';

toast.configure();

const semver = require('semver');

const DataContext = React.createContext();

// use cloud optimizes s3 pricing to standardize between both nerdpacks
const pricingURL = `https://nr1-cloud-optimize.s3-ap-southeast-2.amazonaws.com`;

// there is no need to query particular types in a workload if we can't provide optimization suggestions (yet)
// the below is used as a simple control for this and stitched at the end of the workload entity search query
const acceptedTypesInWorkload = `AND type IN ('HOST', 'VSPHEREVM', 'VSPHEREHOST', 'APPLICATION')`;

// current max supported
const entitySearchChunkValue = 25;

const optimizationCategories = {
  instance: ['HOST', 'VSPHEREVM', 'VSPHEREHOST'],
  workload: ['WORKLOAD'],
  database: ['APPLICATION'],
  application: ['APPLICATION']
};

const optimizationDefaults = {
  enable: false,
  inclusionPeriodHours: 24,
  cpuUpper: 50,
  memUpper: 50,
  cpuMemUpperOperator: 'AND',
  staleCpu: 5,
  staleMem: 5,
  cpuMemUpperStaleOperator: 'AND',
  staleReceiveBytesPerSec: 0,
  staleTransmitBytesPerSec: 0,
  rxTxStaleOperator: 'AND',
  cpuRightSize: 0.5,
  memRightSize: 0.5,
  rightSizeOperator: '',
  discountMultiplier: 1,
  lastReportPeriod: 24,
  includedInstanceTypes: [],
  excludedInstanceTypes: [],
  excludedGuids: [],
  defaultCloud: 'amazon',
  defaultRegion: 'us-east-1',
  entityCostTotals: {}
};

export class DataProvider extends Component {
  constructor(props) {
    super(props);

    this.state = {
      selectedPage: 'home',
      updatingContext: false,
      accounts: [],
      accountsObj: {},
      userConfig: null,
      rawEntities: [],
      rawEntitiesFetched: false,
      processedApps: [],
      processedHosts: [],
      processedWorkloads: [],
      cloudPricing: {},
      tags: [],
      tagSelection: {}
    };
  }

  async componentDidMount() {
    this.checkVersion();

    let userConfig = await getCollection('optimizationConfig', 'main');
    if (!userConfig) {
      userConfig = { ...optimizationDefaults };
    }

    this.setState({ userConfig }, () => {
      // handle incoming props with postProcessEntities, else run fetchEntities for default view
      this.fetchEntities();
    });
  }

  fetchEntities = async nextCursor => {
    // intentionally do not query tags now, so that we can support incoming entities that only contain a guid and type
    const result = await NerdGraphQuery.query({
      query: entitySearchQuery(nextCursor)
    });
    const entitySearchResult =
      ((((result || {}).data || {}).actor || {}).entitySearch || {}).results ||
      {};

    if (entitySearchResult.entities.length > 0) {
      let { rawEntities } = this.state;
      rawEntities = [...rawEntities, ...entitySearchResult.entities];
      this.setState({ rawEntities });
    }

    if (entitySearchResult.nextCursor) {
      this.fetchEntities(entitySearchResult.nextCursor);
    } else if (
      !entitySearchResult.nextCursor ||
      entitySearchResult.entities.length === 0
    ) {
      // completed
      this.setState({ rawEntitiesFetched: true }, () =>
        this.postProcessEntities()
      );
    }
  };

  postProcessEntities = async guids => {
    let { rawEntities } = this.state;
    rawEntities = [...rawEntities, ...(guids || [])];

    const nonWorkloadEntities = [];
    let workloadEntities = [];

    for (let z = 0; z < rawEntities.length; z++) {
      if (rawEntities[z].type === 'WORKLOAD') {
        workloadEntities.push(rawEntities[z]);
      } else {
        nonWorkloadEntities.push(rawEntities[z]);
      }
    }

    // get workload guid datacenter docs & entities first
    // this way pricing can be retrieved and used for non public cloud entities
    if (workloadEntities.length > 0) {
      workloadEntities = await this.processWorkloads(workloadEntities);
    }

    let entities = await this.getEntityData(nonWorkloadEntities);

    // stitch relevant entities back into workloads so on prem cost/cu calculations can be made
    workloadEntities = this.addEntityDataToWorkload(entities, workloadEntities);
    workloadEntities = this.calculateWorkloadDatacenterCost(workloadEntities);

    // get pricing, matches and optimized matches and perform any decoration if required
    entities = await this.processEntities(entities, workloadEntities);

    // run again to stitch freshly processed data
    workloadEntities = this.addEntityDataToWorkload(entities, workloadEntities);

    // !!todo: pricing difference in process entities!!

    // console.log(
    //   entities,
    //   workloadEntities,
    //   this.state.tags,
    //   this.state.accounts,
    //   this.state.tagSelection
    // );
  };

  // calculateDatacenterCost
  calculateWorkloadDatacenterCost = workloadEntities => {
    for (let z = 0; z < workloadEntities.length; z++) {
      const doc = workloadEntities[z].dcDoc;
      const costTotal = { value: 0 };

      if (doc && doc.costs) {
        Object.keys(doc.costs).forEach(key => {
          if (!costTotal[key]) costTotal[key] = 0;
          doc.costs[key].forEach(cost => {
            const finalCost =
              cost.units * cost.rate * (12 / cost.recurringMonths);
            costTotal.value += finalCost;
            costTotal[key] += finalCost;
          });
        });
      }

      let totalCU = 0;

      if (workloadEntities[z].entityData) {
        workloadEntities[z].entityData.forEach(entity => {
          let systemSample = null;

          if (entity.systemSample) {
            systemSample = entity.systemSample.results[0];
          }

          if (entity.vsphereVmSample) {
            systemSample = entity.vsphereVmSample.results[0];
          }

          if (systemSample && systemSample['latest.entityGuid']) {
            totalCU +=
              systemSample['latest.coreCount'] +
              systemSample['latest.memoryTotalBytes'] * 1e-9; // BYTES TO GB
          }
        });
      }

      workloadEntities[z].costPerCU =
        totalCU === 0 || costTotal === 0 ? 0 : costTotal.value / 8760 / totalCU;

      workloadEntities[z].costTotal = costTotal;
      workloadEntities[z].totalCU = totalCU;
    }

    return workloadEntities;
  };

  // addEntityDataToWorkload
  addEntityDataToWorkload = (entities, workloadEntities) => {
    for (let z = 0; z < workloadEntities.length; z++) {
      workloadEntities[z].entityData = [];
      for (let y = 0; y < workloadEntities[z].evaluatedEntities.length; y++) {
        const entityIndex = existsInObjArray(
          entities,
          'guid',
          workloadEntities[z].evaluatedEntities[y].guid
        );
        if (entityIndex) {
          workloadEntities[z].entityData.push(entities[entityIndex]);
        }
      }
    }
    return workloadEntities;
  };

  // process entity data
  processEntities = (entities, workloadEntities) => {
    return new Promise(resolve => {
      let { tags, tagSelection } = this.state;
      let entityCostTotals = {
        instances: {
          currentSpend: 0,
          optimizedSpend: 0,
          datacenterSpend: 0,
          cloudSpend: 0,
          spotSpend: 0,
          nonSpotSpend: 0,
          optimizedNonSpotSpend: 0,
          optimizedSpotSpend: 0,
          potentialSavings: 0,
          potentialSavingsWithSpot: 0,
          staleInstances: 0,
          excludedInstances: 0,
          skippedInstances: 0,
          optimizedInstances: 0
        }
      };

      const accounts = [];

      entities.forEach(async e => {
        // store account
        if (existsInObjArray(accounts, 'id', e.account.id) === false) {
          accounts.push({
            id: e.account.id,
            name: e.account.name
          });
        }

        // store tags
        tags = buildTags(tags, e.tags);
        e.tags.forEach(tag => {
          if (!tag.key.includes('Guid')) {
            if (tagSelection[tag.key] === undefined) {
              tagSelection[tag.key] = {};
            }
            if (
              tag.values[0] &&
              tagSelection[tag.key][tag.values[0]] === undefined
            ) {
              tagSelection[tag.key][tag.values[0]] = false;
            }
          }
        });

        const {
          optimizationConfig,
          optimizedWith,
          workload
        } = await this.getOptimizationConfig(e, workloadEntities);
        e.optimizedWith = optimizedWith;

        let coreCount = null;
        let memoryGB = null;

        if (e.systemSample) {
          coreCount = e.systemSample['latest.coreCount'];
          memoryGB = e.systemSample['latest.memoryTotalBytes'] * 1e-9;

          e.systemSample =
            (((e || {}).systemSample || {}).results || {})[0] || null;

          e.networkSamples = ((e || {}).networkSample || {}).results || [];
          e.networkSample = {
            'max.receiveBytesPerSecond': 0,
            'max.transmitBytesPerSecond': 0
          };
          e.networkSamples.forEach(s => {
            e.networkSample['max.receiveBytesPerSecond'] +=
              s['max.receiveBytesPerSecond'];
            e.networkSample['max.transmitBytesPerSecond'] +=
              s['max.transmitBytesPerSecond'];
          });

          if (e.systemSample['provider.instanceLifecycle'] === 'spot') {
            e.isSpot = true;
          }

          if (e.systemSample['latest.awsRegion']) {
            e.cloud = 'amazon';
            e.cloudRegion = e.systemSample['latest.awsRegion'];
          } else if (e.systemSample['latest.regionName']) {
            e.cloud = 'azure';
            e.cloudRegion = e.systemSample['latest.regionName'];
          } else if (e.systemSample['latest.zone']) {
            e.cloud = 'gcp';
            e.cloudRegion = e.systemSample['latest.zone'];
          } else if (e.systemSample['latest.regionId']) {
            e.cloud = 'alibaba';
            e.cloudRegion = e.systemSample['latest.regionId'];
          }
        } else if (e.vsphereHostSample || e.vsphereVmSample) {
          e.vsphereHostSample =
            (((e || {}).vsphereHostSample || {}).results || {})[0] || null;

          if (!e.vsphereHostSample['latest.entityGuid']) {
            delete e.vsphereHostSample;
          }

          e.vsphereVmSample =
            (((e || {}).vsphereVmSample || {}).results || {})[0] || null;
          if (!e.vsphereVmSample['latest.entityGuid']) {
            delete e.vsphereVmSample;
          }

          if (e.vsphereHostSample) {
            coreCount = e.vsphereHostSample['latest.coreCount'];
            memoryGB = e.vsphereHostSample['latest.memoryTotalBytes'] * 1e-9;
          } else if (e.vsphereVmSample) {
            coreCount = e.vsphereVmSample['latest.coreCount'];
            memoryGB = e.vsphereVmSample['latest.memoryTotalBytes'] * 1e-9;
          }
        } else if (e.apmInfraData || e.apmDatabaseSlowQueryData) {
          e.apmInfraData =
            (((e || {}).apmDatabaseSlowQueryData || {}).results || {})[0] ||
            null;

          e.apmDatabaseSlowQueryData =
            (((e || {}).apmDatabaseSlowQueryData || {}).results || {})[0] ||
            null;
        }

        // if system sample or vsphere get instance pricing
        if (e.systemSample || e.vsphereHostSample || e.vsphereVmSample) {
          if (
            e.cloud &&
            e.cloudRegion &&
            e.systemSample['latest.instanceType']
          ) {
            // assess cloud instance
            e.instanceResult = await this.getInstanceCloudPricing(
              e.cloud,
              e.cloudRegion,
              e.systemSample['latest.instanceType']
            );
          } else if (!e.cloud) {
            if (!isNaN(coreCount) && !isNaN(memoryGB)) {
              e.matchedInstances = await this.getCloudInstances(
                optimizationConfig,
                coreCount,
                Math.round(memoryGB)
              );
            }

            // check if exists in workload and if DC costing is available
            if (workload && workload.costPerCU) {
              const instanceCU = Math.round(memoryGB + coreCount);
              e.DatacenterCUCost = instanceCU * workload.costPerCU;
            }
          }

          // get optimized matches
          if (!optimizationConfig) {
            e.optimizedData = null;
          } else {
            e.optimizedData = await this.getOptimizedMatches(
              e.instanceResult,
              e.systemSample || e.vsphereHostSample || e.vsphereVmSample,
              optimizationConfig
            );
          }

          // perform instance calculations
          entityCostTotals = addInstanceCostTotal(entityCostTotals, e);
        }
      });

      this.setState({ accounts, tags, tagSelection }, () => {
        console.log(entityCostTotals, entities);
        resolve(entities);
      });
    });
  };

  getCloudInstances = async (optimizationConfig, cpu, mem) => {
    const cloudPrices = await this.getInstanceCloudPricing(
      optimizationConfig.defaultCloud,
      optimizationConfig.defaultRegion
    );

    if (cloudPrices) {
      const exactMatchedProducts = {};
      for (let z = 0; z < cloudPrices.length; z++) {
        if (!exactMatchedProducts[cloudPrices[z].category]) {
          exactMatchedProducts[cloudPrices[z].category] = null;
        }

        if (this.checkIncludeExclude(optimizationConfig, cloudPrices[z])) {
          break;
        }

        if (
          cloudPrices[z].cpusPerVm === cpu &&
          cloudPrices[z].memPerVm === mem
        ) {
          exactMatchedProducts[cloudPrices[z].category] = cloudPrices[z];
        }
      }

      const nextMatchedProducts = {};

      // get cheapest from each missing price category
      Object.keys(exactMatchedProducts).forEach(category => {
        if (!exactMatchedProducts[category]) {
          for (let z = 0; z < cloudPrices.length; z++) {
            if (this.checkIncludeExclude(optimizationConfig, cloudPrices[z])) {
              break;
            }

            if (
              cloudPrices[z].category === category &&
              cloudPrices[z].cpusPerVm >= cpu &&
              cloudPrices[z].memPerVm >= mem
            ) {
              nextMatchedProducts[category] = cloudPrices[z];
              break;
            }
          }
          delete exactMatchedProducts[category];
        }
      });

      const matchedInstances = { exactMatchedProducts, nextMatchedProducts };

      return matchedInstances;
    } else {
      return null;
    }
  };

  // check the include exclude filters, and return true if we need to skip this product
  checkIncludeExclude = (config, product) => {
    if (config && config.enable) {
      // skip excluded instances
      if (config.excludedInstanceTypes) {
        for (let y = 0; y < config.excludedInstanceTypes.length; y++) {
          if (product.type.includes(config.excludedInstanceTypes[y].value)) {
            return true;
          }
        }
      }
      // only keep included instances
      if (
        config.includedInstanceTypes &&
        config.includedInstanceTypes.length > 0
      ) {
        let isIncluded = false;
        for (let y = 0; y < config.includedInstanceTypes.length; y++) {
          if (product.type.includes(config.includedInstanceTypes[y].value)) {
            isIncluded = true;
          }
        }

        if (!isIncluded) return true;
      }
    }

    return false;
  };

  getOptimizationConfig = async (e, workloadEntities) => {
    let optimizationConfig = null;
    let optimizedWith = null;

    // check if guid exists in a workload to pull optimization config
    const workload = this.checkGuidInWorkload(e.guid, workloadEntities);
    if (workload && workload.optimizationConfig) {
      optimizationConfig = workload.optimizationConfig;
      optimizedWith = 'workloadConfig';
    }

    // if no workload config, check account storage
    if (!optimizationConfig) {
      const accountOptimizationConfig = await this.getAccountOptimizationConfig(
        e.account.id,
        e.account.name
      );
      if (accountOptimizationConfig) {
        optimizationConfig = accountOptimizationConfig;
        optimizedWith = 'accountConfig';
      }
    }

    // if no workload config, user settings
    if (!optimizationConfig) {
      optimizationConfig = this.state.userConfig;
      optimizedWith = 'userConfig';
    }

    return { optimizationConfig, optimizedWith, workload };
  };

  getAccountOptimizationConfig = (accountId, accountName) => {
    return new Promise(resolve => {
      const { accountsObj } = this.state;
      if (accountsObj.accountId && accountsObj.accountId.optimizationConfig) {
        resolve(accountsObj.accountId.optimizationConfig);
      } else if (
        !accountsObj[accountId] ||
        (accountsObj[accountId] &&
          !accountsObj[accountId].checkedOptimizationConfig)
      ) {
        accountsObj[accountId] = { name: accountName };
        getAccountCollection(accountId, 'optimizationConfig', 'main').then(
          value => {
            accountsObj[accountId].checkedOptimizationConfig = true;

            if (value) {
              accountsObj[accountId].optimizationConfig = value;
            }

            this.setState({ accountsObj }, () => {
              resolve(value);
            });
          }
        );
      } else {
        resolve(null);
      }
    });
  };

  // get cloud pricing
  // checks cloud pricing in state, else will fetch and store
  getInstanceCloudPricing = (cloud, region, instanceType) => {
    const { cloudPricing } = this.state;
    return new Promise(resolve => {
      const pricingKey = `${cloud}_${region}`;
      if (cloudPricing[pricingKey]) {
        if (instanceType) {
          // provide direct instance type price
          for (let z = 0; z < cloudPricing[pricingKey].length; z++) {
            if (cloudPricing[pricingKey][z].type === instanceType) {
              resolve(cloudPricing[pricingKey][z]);
            }
          }
          resolve(null);
        } else {
          resolve(cloudPricing[pricingKey]);
        }
      } else {
        fetch(`${pricingURL}/${cloud}/compute/pricing/${region}.json`)
          .then(response => {
            return response.json();
          })
          .then(json => {
            cloudPricing[pricingKey] = json.products;
            this.setState({ cloudPricing }, () => {
              if (instanceType) {
                for (let z = 0; z < cloudPricing[pricingKey].length; z++) {
                  if (cloudPricing[pricingKey][z].type === instanceType) {
                    resolve(cloudPricing[pricingKey][z]);
                  }
                }
                resolve(null);
              } else {
                resolve(json.products);
              }
            });
          });
      }
    });
  };

  // collect entity data
  getEntityData = async nonWorkloadEntities => {
    // chunk entity guids
    const guidChunks = chunk(
      nonWorkloadEntities.map(e => e.guid),
      entitySearchChunkValue
    );

    const guidPromises = guidChunks.map(chunk =>
      NerdGraphQuery.query({
        query: getEntityDataQuery,
        variables: { guids: chunk }
      })
    );

    let completeEntities = [];

    await Promise.all(guidPromises).then(values => {
      values.forEach(v => {
        const entities = (((v || {}).data || {}).actor || {}).entities || [];
        if (entities.length > 0) {
          completeEntities = [...completeEntities, ...entities];
        }
      });
    });

    return completeEntities;
  };

  trueIndex = (chunkedIndex, valueIndex) => {
    if (chunkedIndex === 0) {
      return valueIndex;
    } else {
      const startIndex = chunkedIndex * entitySearchChunkValue;
      return startIndex + valueIndex;
    }
  };

  // search for non cloud entity type within workload for on prem costing
  checkGuidInWorkload = (guid, workloads) => {
    for (let z = 0; z < workloads.length; z++) {
      for (let y = 0; y < workloads[z].evaluatedEntities.length; y++) {
        if (guid === workloads[z].evaluatedEntities[y].guid) {
          return workloads[z];
        }
      }
    }
    return null;
  };

  processWorkloads = async workloadGuids => {
    // get docs
    // // get dcDoc
    const workloadDocPromises = workloadGuids.map(wl =>
      getEntityCollection('dcDoc', wl.guid, 'dcDoc')
    );

    await Promise.all(workloadDocPromises).then(values => {
      values.forEach((v, i) => {
        // do not replace dcDoc if an incoming guid had a doc supplied
        if (!workloadGuids[i].dcDoc) {
          workloadGuids[i].dcDoc = v;
        }
      });
    });
    // // get optimizationConfig
    const workloadOptimizationCfgPromises = workloadGuids.map(wl =>
      getEntityCollection('optimizationConfig', wl.guid, 'main')
    );

    await Promise.all(workloadOptimizationCfgPromises).then(values => {
      values.forEach((v, i) => {
        // do not replace optimizationConfig if an incoming guid had a optimizationConfig supplied
        if (!workloadGuids[i].optimizationConfig) {
          workloadGuids[i].optimizationConfig = v;
        }
      });
    });

    // get queries
    const entityWorkloadQueryPromises = workloadGuids.map(wl =>
      NerdGraphQuery.query({
        query: workloadQueries,
        variables: { guid: wl.guid, accountId: wl.account.id }
      })
    );

    await Promise.all(entityWorkloadQueryPromises).then(values => {
      values.forEach(async (v, i) => {
        if (!workloadGuids[i].entitySearchQuery) {
          const workload =
            ((((v || {}).data || {}).actor || {}).account || {}).workload ||
            null;

          const collection = workload.collection || null;

          if (collection) {
            workloadGuids[i].entitySearchQuery = collection.entitySearchQuery; // <- evaluate this query
            workloadGuids[i].entities = collection.entities;
            workloadGuids[i].permalink = collection.permalink;
            workloadGuids[i].name = workload.name;
          }
        }
      });
    });

    // stitch resolved entities
    const evaluateQueryPromises = workloadGuids.map(wl =>
      this.evaluateWorkloadEntitySearchQuery(wl.entitySearchQuery)
    );

    await Promise.all(evaluateQueryPromises).then(values => {
      values.forEach((v, i) => {
        workloadGuids[i].evaluatedEntities = v;
      });
    });

    // chunk and stitch tags
    const entityWorkloadChunks = chunk(workloadGuids, entitySearchChunkValue);
    const entityWorkloadTagPromises = entityWorkloadChunks.map(chunk =>
      NerdGraphQuery.query({
        query: getWorkloadTags,
        variables: { guids: chunk.map(wl => wl.guid) }
      })
    );

    await Promise.all(entityWorkloadTagPromises).then(values => {
      values.forEach(v => {
        const results = (((v || {}).data || {}).actor || {}).entities || [];
        results.forEach(r => {
          const checkIndex = existsInObjArray(workloadGuids, 'guid', r.guid);
          if (checkIndex !== false) {
            workloadGuids[checkIndex].tags = r.tags;
          }
        });
      });
    });

    return workloadGuids;
  };

  evaluateWorkloadEntitySearchQuery = (query, cursor, entities) => {
    return new Promise(resolve => {
      if (!entities) {
        entities = [];
      }

      const ngQuery = `{
      actor {
        entitySearch(query: "${query} ${acceptedTypesInWorkload}") {
          results${cursor ? `(cursor: "${cursor}")` : ''} {
            entities {
              guid
              type
            }
            nextCursor
          }
        }
      }
    }`;

      NerdGraphQuery.query({
        query: ngQuery
      }).then(async v => {
        const results =
          ((((v || {}).data || {}).actor || {}).entitySearch || {}).results ||
          [];

        if (results.entities && results.entities.length > 0) {
          entities = [...entities, ...results.entities];
        }

        if (results.nextCursor) {
          // seems to work as intended
          console.log('recursing');
          const recursedEntities = await this.evaluateWorkloadEntitySearchQuery(
            query,
            results.nextCursor,
            entities
          );
          resolve(recursedEntities);
        } else {
          resolve(entities);
        }
      });
    });
  };

  checkVersion = () => {
    fetch(
      'https://raw.githubusercontent.com/newrelic/nr1-cloud-optimize/master/package.json'
    )
      .then(response => {
        return response.json();
      })
      .then(repoPackage => {
        if (pkg.version === repoPackage.version) {
          console.log(`Running latest version: ${pkg.version}`);
        } else if (semver.lt(pkg.version, repoPackage.version)) {
          toast.warn(
            <a
              onClick={() =>
                window.open(
                  'https://github.com/newrelic/nr1-cloud-optimize/',
                  '_blank'
                )
              }
            >{`New version available: ${repoPackage.version}`}</a>,
            {
              autoClose: 5000,
              containerId: 'C'
            }
          );
        } else if (semver.lt(repoPackage.version, pkg.version)) {
          console.log(`Running newer version: ${pkg.version}`);
        } else {
          console.log(`Running unknown version: ${pkg.version}`);
        }
      });
  };

  updateDataState = (stateData, actions) => {
    return new Promise((resolve, reject) => {
      const newState = { ...stateData, updatingContext: true };

      this.setState(newState, () => {
        // do stuff with updated state if required

        // completed update
        this.setState({ updatingContext: false }, () => {
          resolve(true);
        });
      });
    });
  };

  getOptimizedMatches = async (
    instanceResult,
    systemSample,
    optimizationConfig
  ) => {
    // if (!optimizationConfig || !optimizationConfig.enable) return null;

    const optimizationData = {};
    const maxCpu = systemSample['max.cpuPercent'];
    const maxMem = systemSample['max.memoryPercent'];

    // assess inclusion period
    const timeSinceLastReported =
      new Date().getTime() - systemSample['latest.timestamp'];
    if (
      timeSinceLastReported >
      parseFloat(optimizationConfig.inclusionPeriodHours || 0) * 3600000
    ) {
      return { state: 'excluded' };
    }

    // assess staleness params
    const cpuStale =
      optimizationConfig.staleCpu !== 0 && maxCpu < optimizationConfig.staleCpu;

    const memStale =
      optimizationConfig.staleCpu !== 0 && maxMem < optimizationConfig.staleMem;

    const cpuMemUpperStaleOperator =
      optimizationConfig.cpuMemUpperStaleOperator || 'AND';

    if (
      (cpuMemUpperStaleOperator === 'AND' && cpuStale && memStale) ||
      (cpuMemUpperStaleOperator === 'OR' && (cpuStale || memStale))
    ) {
      return { state: 'stale' };
    }

    // optimize
    // assess upper limit params
    const cpuOptimize =
      optimizationConfig.cpuUpper !== 0 && maxCpu < optimizationConfig.cpuUpper;

    const memOptimize =
      optimizationConfig.memUpper !== 0 && maxMem < optimizationConfig.memUpper;

    const cpuMemUpperOperator = optimizationConfig.cpuMemUpperOperator || 'AND';

    if (
      (cpuMemUpperOperator === 'AND' && cpuOptimize && memOptimize) ||
      (cpuMemUpperOperator === 'OR' && (cpuOptimize || memOptimize))
    ) {
      // optimize
      let cpuCount = 0;
      let memGb = 0;
      if (instanceResult) {
        cpuCount = instanceResult.cpusPerVm;
        memGb = instanceResult.memPerVm;
      } else {
        cpuCount = systemSample['latest.coreCount'];
        memGb = systemSample['latest.memoryTotalBytes'] * 1e-9;
      }

      cpuCount = roundHalf(cpuCount * optimizationConfig.cpuRightSize);
      memGb = roundHalf(memGb * optimizationConfig.cpuRightSize);

      optimizationData.matchedInstances = await this.getCloudInstances(
        optimizationConfig,
        cpuCount,
        memGb
      );

      if (optimizationData.matchedInstances) {
        if (
          optimizationData.matchedInstances.exactMatchedProducts &&
          Object.keys(optimizationData.matchedInstances.exactMatchedProducts)
            .length > 0
        ) {
          optimizationData.state = 'optimized-exact';
        } else if (
          optimizationData.matchedInstances.nextMatchedProducts &&
          Object.keys(optimizationData.matchedInstances.nextMatchedProducts)
            .length > 0
        ) {
          optimizationData.state = 'optimized-next';
        }
      }
    }

    return optimizationData;
  };

  // fetch data as required, supply array things to fetch
  dataFetcher = async actions => {
    console.log('context dataFetcher');
    const dataPromises = [];
    const content = [];

    actions.forEach(action => {
      switch (action) {
        case 'accounts': {
          content.push(action);
          const accountsQuery = `{actor {accounts {name id}}}`;
          dataPromises.push(NerdGraphQuery.query({ query: accountsQuery }));
          break;
        }
      }
    });

    await Promise.all(dataPromises).then(async values => {
      const data = {};
      values.forEach((value, i) => {
        switch (content[i]) {
          case 'accounts':
            data.accounts =
              (((value || {}).data || {}).actor || {}).accounts || [];
            break;
        }
      });

      this.setState(data);
    });
  };

  render() {
    const { children } = this.props;

    return (
      <DataContext.Provider
        value={{
          ...this.state,
          updateDataState: this.updateDataState
        }}
      >
        <ToastContainer
          enableMultiContainer
          containerId="B"
          position={toast.POSITION.TOP_RIGHT}
        />

        <ToastContainer
          enableMultiContainer
          containerId="C"
          position={toast.POSITION.BOTTOM_RIGHT}
        />

        {children}
      </DataContext.Provider>
    );
  }
}

export const DataConsumer = DataContext.Consumer;