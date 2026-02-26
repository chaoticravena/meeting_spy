// src/components/JobProfileManager.jsx
import { useState, useEffect } from 'react';
import { api } from '../api';

export function JobProfileManager({ onSelect, selectedId, onClose }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: '',
    company: '',
    description: '',
    key_skills: '',
    seniority: 'senior',
    focus_areas: '',
    isDefault: false
  });

  useEffect(() => {
    loadJobs();
  }, []);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const data = await api.listJobs();
      setJobs(data);
    } catch (err) {
      console.error('Failed to load jobs:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const skills = form.key_skills.split(',').map(s => s.trim()).filter(Boolean);
      const areas = form.focus_areas.split(',').map(s => s.trim()).filter(Boolean);
      
      await api.createJob({
        ...form,
        key_skills: skills,
        focus_areas: areas
      });
      
      setShowForm(false);
      setForm({
        name: '',
        company: '',
        description: '',
        key_skills: '',
        seniority: 'senior',
        focus_areas: '',
        isDefault: false
      });
      loadJobs();
    } catch (err) {
      alert('Failed to create job: ' + err.message);
    }
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!confirm('Delete this job profile?')) return;
    try {
      await api.deleteJob(id);
      loadJobs();
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
  };

  const selectJob = (job) => {
    onSelect(job);
    onClose();
  };

  return (
    <div className="job-manager">
      <div className="job-manager-header">
        <h3>Job Profiles</h3>
        <button className="btn-close" onClick={onClose}>×</button>
      </div>

      <div className="job-list">
        {loading ? (
          <div className="loading">Loading...</div>
        ) : jobs.length === 0 ? (
          <div className="empty">No job profiles yet. Create one!</div>
        ) : (
          jobs.map(job => (
            <div 
              key={job.id} 
              className={`job-card ${selectedId === job.id ? 'selected' : ''} ${job.isDefault ? 'default' : ''}`}
              onClick={() => selectJob(job)}
            >
              <div className="job-card-header">
                <div className="job-title">
                  <strong>{job.name}</strong>
                  {job.isDefault && <span className="badge-default">DEFAULT</span>}
                </div>
                <button 
                  className="btn-delete" 
                  onClick={(e) => handleDelete(job.id, e)}
                  title="Delete"
                >
                  🗑
                </button>
              </div>
              
              <div className="job-company">{job.company || 'Unknown Company'} • {job.seniority}</div>
              
              <div className="job-skills">
                {job.key_skills.slice(0, 4).map(skill => (
                  <span key={skill} className="skill-tag">{skill}</span>
                ))}
                {job.key_skills.length > 4 && (
                  <span className="skill-more">+{job.key_skills.length - 4}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {!showForm ? (
        <button className="btn-add" onClick={() => setShowForm(true)}>
          + New Job Profile
        </button>
      ) : (
        <form className="job-form" onSubmit={handleSubmit}>
          <h4>Create Job Profile</h4>
          
          <div className="form-row">
            <input 
              placeholder="Job Title (e.g., Senior Data Engineer)"
              value={form.name}
              onChange={e => setForm({...form, name: e.target.value})}
              required
            />
          </div>
          
          <div className="form-row">
            <input 
              placeholder="Company Name"
              value={form.company}
              onChange={e => setForm({...form, company: e.target.value})}
            />
          </div>
          
          <div className="form-row">
            <select 
              value={form.seniority}
              onChange={e => setForm({...form, seniority: e.target.value})}
            >
              <option value="junior">Junior</option>
              <option value="mid">Mid-Level</option>
              <option value="senior">Senior</option>
              <option value="staff">Staff/Principal</option>
            </select>
          </div>
          
          <div className="form-row">
            <textarea 
              placeholder="Paste full job description here...
              
The AI will extract key requirements and tailor answers accordingly."
              rows={6}
              value={form.description}
              onChange={e => setForm({...form, description: e.target.value})}
              required
            />
          </div>
          
          <div className="form-row">
            <input 
              placeholder="Key skills (comma separated): SQL, Spark, Python, Airflow, dbt..."
              value={form.key_skills}
              onChange={e => setForm({...form, key_skills: e.target.value})}
              required
            />
          </div>
          
          <div className="form-row">
            <input 
              placeholder="Focus areas: streaming, data_warehousing, ml_ops, platform..."
              value={form.focus_areas}
              onChange={e => setForm({...form, focus_areas: e.target.value})}
            />
          </div>
          
          <label className="form-checkbox">
            <input 
              type="checkbox"
              checked={form.isDefault}
              onChange={e => setForm({...form, isDefault: e.target.checked})}
            />
            Set as default for new sessions
          </label>
          
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              Save Profile
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
