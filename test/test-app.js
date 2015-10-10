/* eslint-env mocha */
import chai from 'chai';
import supertest from 'supertest';
import redis from 'redis';
import bluebird from 'bluebird';

import app from '../src/app';
import config from '../src/config';

const expect = chai.expect;

const client = bluebird.promisifyAll(redis.createClient());
const request = bluebird.promisifyAll(supertest);


describe('Express server', () => {
  beforeEach(() => {
    config.FRIGG_WORKER_TOKEN = 'token';
    config.FRIGG_WORKER_VERSION = null;
    config.FRIGG_SETTINGS_VERSION = null;
    config.FRIGG_COVERAGE_VERSION = null;

    return client.selectAsync(2).then(() => {
      return bluebird.all([
        client.delAsync('frigg:queue'),
        client.delAsync('frigg:queue:custom'),
        client.delAsync('frigg:webhooks'),
        client.delAsync('frigg:worker:last_seen'),
      ]);
    });
  });

  describe('/*', () => {
    it('should redirect to frigg.io', () => {
      return request(app)
        .get('/')
        .expectAsync(302);
    });
  });

  describe('/fetch', () => {
    it('should return 403 without token', () => {
      return request(app)
        .get('/fetch')
        .expectAsync(403);
    });

    it('should return 200 if there is no job', () => {
      return request(app)
      .get('/fetch')
      .set('x-frigg-worker-token', 'token')
      .expectAsync(200);
    });

    it('should return null if there is no job', () => {
      return request(app)
        .get('/fetch')
        .set('x-frigg-worker-token', 'token')
        .endAsync()
        .then(res => {
          expect(res.body).to.deep.equal({job: null});
        });
    });

    it('should log last fetch', () => {
      return request(app)
        .get('/fetch')
        .set('x-frigg-worker-token', 'token')
        .set('x-frigg-worker-host', 'ron')
        .endAsync()
        .then(() => {
          return client.selectAsync(2);
        })
        .then(() => {
          return client.hgetallAsync('frigg:worker:last_seen');
        })
        .then(res => {
          expect(res).to.contain.key('ron');
        });
    });

    it('should log last fetch when host is not set', () => {
      return request(app)
        .get('/fetch')
        .set('x-frigg-worker-token', 'token')
        .endAsync()
        .then(() => {
          return client.selectAsync(2);
        })
        .then(() => {
          return client.hgetallAsync('frigg:worker:last_seen');
        })
        .then(res => {
          expect(res).to.contain.key('::ffff:127.0.0.1');
        });
    });

    it('should allow access from new worker if the requirement allows it', () => {
      config.FRIGG_WORKER_VERSION = '>=1.0.0';
      return request(app)
        .get('/fetch')
        .set('x-frigg-worker-token', 'token')
        .set('x-frigg-worker-version', '1.5.0')
        .expect(200)
        .endAsync()
        .then(res => {
          expect(res.body.job).to.equal(null);
        });
    });

    it('should deny access from old worker (worker)', () => {
      config.FRIGG_WORKER_VERSION = '1.0.0';
      return request(app)
        .get('/fetch')
        .set('x-frigg-worker-token', 'token')
        .expect(400).endAsync()
        .then(res => {
          expect(res.body.error).to.contain({
            code: 'OUTDATED',
            message: 'The worker is outdated. Please update.',
          });
        });
    });

    it('should deny access from old worker (settings)', () => {
      config.FRIGG_SETTINGS_VERSION = '1.0.0';
      return request(app)
        .get('/fetch')
        .set('x-frigg-worker-token', 'token')
        .expect(400).endAsync()
        .then(res => {
          expect(res.body.error).to.contain({
            code: 'OUTDATED',
            message: 'The worker is outdated. Please update.',
          });
        });
    });

    it('should deny access from old worker (coverage)', () => {
      config.FRIGG_COVERAGE_VERSION = '1.0.0';
      return request(app)
        .get('/fetch')
        .set('x-frigg-worker-token', 'token')
        .expect(400)
        .endAsync()
        .then(res => {
          expect(res.body.error).to.contain({
            code: 'OUTDATED',
            message: 'The worker is outdated. Please update.',
          });
        });
    });

    it('should return job', () => {
      const jobObj = {
        'branch': 'master',
        'clone_url': 'url',
      };
      return client.selectAsync(2)
        .then(() => {
          return client.lpushAsync('frigg:queue', JSON.stringify(jobObj));
        })
        .then(() => {
          return request(app)
          .get('/fetch')
          .set('x-frigg-worker-token', 'token')
          .expect(200)
          .endAsync();
        })
        .then(res => {
          expect(res.body.job.branch).to.equal('master');
          expect(res.body.job.clone_url).to.equal('url');
        });
    });

    it('should return job from custom queue', () => {
      const jobObj = {
        'branch': 'master',
        'clone_url': 'url-custom',
      };
      return client.selectAsync(2)
        .then(() => {
          return client.lpushAsync('frigg:queue:custom', JSON.stringify(jobObj));
        })
        .then(() => {
          return request(app)
            .get('/fetch/custom')
            .set('x-frigg-worker-token', 'token')
            .expect(200)
            .endAsync();
        })
        .then(res => {
          expect(res.body.job.branch).to.equal('master');
          expect(res.body.job.clone_url).to.equal('url-custom');
        });
    });
  });

  describe('/webhooks/:slug', () => {
    it('should return 202', () => {
      return request(app).post('/webhooks/cvs').expectAsync(202);
    });
    it('should put payload on redis queue', () => {
      const payload = {
        'ref': 'refs/heads/master',
        'after': 'ba6854eb994c433b48a3be20fc04cae93d6929a6',
      };

      return request(app)
        .post('/webhooks/cvs')
        .set('X-Github-Event', 'push')
        .send(payload).expect(202)
        .endAsync()
        .then(() => {
          return client.selectAsync(2);
        })
        .then(() => {
          return client.lrangeAsync('frigg:webhooks', 0, -1);
        })
        .then(queue => {
          expect(queue.length).to.equal(1);
          const item = JSON.parse(queue[0]);
          expect(item.service).to.equal('cvs');
          expect(item.payload).to.eql(payload);
        });
    });
  });

  describe('/webhooks/github', () => {
    it('should return 202', () => {
      return request(app).post('/webhooks/github').expectAsync(202);
    });

    it('should put payload on redis queue', () => {
      const payload = {
        'ref': 'refs/heads/master',
        'after': 'ba6854eb994c433b48a3be20fc04cae93d6929a6',
      };

      return request(app)
        .post('/webhooks/github')
        .set('X-Github-Event', 'push')
        .send(payload)
        .expect(202)
        .endAsync()
        .then(() => {
          return client.selectAsync(2);
        })
        .then(() => {
          return client.lrangeAsync('frigg:webhooks', 0, -1);
        })
        .then(queue => {
          expect(queue.length).to.equal(1);
          const item = JSON.parse(queue[0]);
          expect(item.service).to.equal('github');
          expect(item.type).to.equal('push');
          expect(item.payload).to.eql(payload);
        });
    });
  });
});
